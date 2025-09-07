import express from "express";
import puppeteer from "puppeteer";
import qs from "qs";

const app = express();
const PORT = process.env.PORT || 3000;

/** Domínios permitidos (voodc + subdomínios) */
function isAllowed(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    if (hostname === "voodc.com" || hostname === "www.voodc.com") return true;
    // permite subdomínios: *.voodc.com
    return hostname.endsWith(".voodc.com");
  } catch {
    return false;
  }
}

/** Tenta clicar/acionar players em TODAS as frames (página e iframes) */
async function pokeAllFrames(page) {
  const selectors = [
    ".vjs-big-play-button",
    "button[aria-label='Play']",
    "button[title='Play']",
    "button[aria-label='Reproduzir']",
    "button[title='Reproduzir']",
    "div[role='button']",
    ".plyr__control--overlaid",
    ".jw-icon-playback",
    ".shaka-play-button",
  ];

  // 1) clique genérico no centro da viewport
  try {
    const { width, height } = await page.viewport() || { width: 800, height: 600 };
    await page.mouse.move(Math.floor(width / 2), Math.floor(height / 2));
    await page.mouse.click(Math.floor(width / 2), Math.floor(height / 2), { delay: 40 });
  } catch {}

  // 2) dispare cliques por selectors em TODAS as frames
  const frames = page.frames();
  for (const frame of frames) {
    try {
      await frame.evaluate((sels) => {
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el) {
            el.click();
          }
        }
        // gesto genérico de usuário
        document.body && document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }, selectors);
    } catch {}
  }

  // 3) tente tocar vídeos diretamente (muted para burlar autoplay policy)
  for (const frame of frames) {
    try {
      await frame.evaluate(() => {
        const vids = Array.from(document.querySelectorAll("video"));
        for (const v of vids) {
          try {
            v.muted = true;
            // alguns players pausam se sem controles; adiciona atributo por garantia
            v.setAttribute("playsinline", "true");
            v.setAttribute("muted", "true");
            v.play().catch(() => {});
          } catch {}
        }
      });
    } catch {}
  }

  // 4) teclas comuns de play (espaco/k)
  try { await page.keyboard.press(" "); } catch {}
  try { await page.keyboard.press("k"); } catch {}
}

/** Extrai a primeira URL .m3u8 vista nos requests/responses (inclui iframes) */
async function extractM3U8FromPage(pageUrl) {
  if (!isAllowed(pageUrl)) {
    throw new Error("Host não permitido para extração.");
  }

  const browser = await puppeteer.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  let m3u8 = null;
  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();

  // UA de desktop
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7" });

  // Logs para debug (aparecem na Koyeb)
  page.on("framenavigated", (frame) => {
    try {
      console.log("[frame] navigated:", frame.url()?.slice(0, 200));
    } catch {}
  });

  // captura todas as requisições .m3u8 (página + subframes)
  page.on("request", (req) => {
    const url = req.url();
    if (/\.m3u8(\?|$)/i.test(url)) {
      if (!m3u8) {
        m3u8 = url;
        console.log("[M3U8][request] ", url);
      }
    }
  });

  // e também via responses (às vezes chega por fetch)
  page.on("response", (resp) => {
    const url = resp.url();
    if (/\.m3u8(\?|$)/i.test(url)) {
      if (!m3u8) {
        m3u8 = url;
        console.log("[M3U8][response]", url);
      }
    }
  });

  const GOTO_TIMEOUT = 25000;     // 25s pra carregar o embed
  const GLOBAL_TIMEOUT = 60000;   // 60s pra detectar o m3u8

  try {
    console.log("[goto]", pageUrl);
    // "domcontentloaded" evita travar caso a página nunca entre em network idle
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT });

    // dá um respiro e tenta interação
    await page.waitForTimeout(1200);
    await pokeAllFrames(page);

    // laço de espera por até 60s
    const t0 = Date.now();
    while (!m3u8 && Date.now() - t0 < GLOBAL_TIMEOUT) {
      await page.waitForTimeout(500);

      // tenta novamente “cutucar” frames a cada 2,5s
      if ((Date.now() - t0) % 2500 < 600) {
        await pokeAllFrames(page);
      }
    }

    if (!m3u8) {
      throw new Error(`Timed out after waiting ${GLOBAL_TIMEOUT}ms`);
    }
    return m3u8;
  } finally {
    try { await ctx.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

/* ========================= ROTAS HTTP ========================= */

app.get("/", (_req, res) => {
  res.type("html").send(`
    <h2>Gerador de Player (voodc → seu player)</h2>
    <ul>
      <li><code>/extract?url=https://voodc.com/...</code> → retorna JSON com o .m3u8</li>
      <li><code>/make-player?url=https://voodc.com/...&title=Meu%20Canal</code> → responde HTML do seu player</li>
    </ul>
    <p style="font:14px system-ui;color:#888">Dica: passe o parâmetro <b>url</b> em URL-encoded.</p>
  `);
});

app.get("/extract", async (req, res) => {
  const pageUrl = req.query.url;
  if (!pageUrl) return res.status(400).json({ error: "Informe ?url=" });

  try {
    const m3u8 = await extractM3U8FromPage(String(pageUrl));
    res.json({ m3u8 });
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.error("[extract][error]", msg);
    res.status(500).type("text/plain").send("Falha ao extrair .m3u8: " + msg);
  }
});

app.get("/player", (req, res) => {
  const m3u8 = req.query.m3u8;
  const title = req.query.title || "Player";
  if (!m3u8) return res.status(400).send("Faltou ?m3u8=");

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<style>
  html,body{height:100%;width:100%;margin:0;background:#000}
  #wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#000}
  video{width:100vw;height:100vh;background:#000}
  .brand{position:fixed;top:12px;left:12px;color:#fff;font:600 14px/1.2 system-ui,Arial}
</style>
</head>
<body>
<div id="wrap">
  <video id="video" controls autoplay playsinline></video>
  <div class="brand">${title}</div>
</div>
<script>
const src = ${JSON.stringify(String(m3u8))};
const video = document.getElementById('video');

if (Hls.isSupported()) {
  const hls = new Hls({ maxBufferLength: 20, enableWorker: true });
  hls.loadSource(src);
  hls.attachMedia(video);
  hls.on(Hls.Events.ERROR, (_, data) => console.warn("HLS error:", data.type, data.details));
} else if (video.canPlayType('application/vnd.apple.mpegurl')) {
  video.src = src;
} else {
  document.body.innerHTML = '<p style="color:#fff">Navegador sem suporte a HLS.</p>';
}
</script>
</body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.get("/make-player", async (req, res) => {
  const pageUrl = req.query.url;
  const title = req.query.title || "Player";
  if (!pageUrl) return res.status(400).send("Use ?url=<voodc>");

  try {
    const m3u8 = await extractM3U8FromPage(String(pageUrl));
    const query = qs.stringify({ m3u8, title });
    res.redirect(`/player?${query}`);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.error("[make-player][error]", msg);
    res.status(500).type("text/plain").send("Falha ao extrair .m3u8: " + msg);
  }
});

app.listen(PORT, () => console.log("Rodando na porta", PORT));
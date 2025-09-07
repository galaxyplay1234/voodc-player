import express from "express";
import puppeteer from "puppeteer";
import qs from "qs";

const app = express();
const PORT = process.env.PORT || 3000;

/* ===== Helpers ===== */

function isAllowed(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    // permite voodc.com, www.voodc.com e QUALQUER subdomínio *.voodc.com
    if (hostname === "voodc.com" || hostname === "www.voodc.com") return true;
    return hostname.endsWith(".voodc.com");
  } catch {
    return false;
  }
}

async function pokeAllFrames(page) {
  const selectors = [
    ".vjs-big-play-button",
    "button[aria-label='Play']",
    "button[title='Play']",
    "button[aria-label='Reproduzir']",
    "button[title='Reproduzir']",
    ".plyr__control--overlaid",
    ".jw-icon-playback",
    ".shaka-play-button",
    "button.play",
    ".btn-play",
  ];

  // 1) clique no centro da viewport da página principal
  try {
    const vp = page.viewport() || { width: 1280, height: 720 };
    const cx = Math.floor(vp.width / 2);
    const cy = Math.floor(vp.height / 2);
    await page.mouse.move(cx, cy);
    await page.mouse.click(cx, cy, { delay: 40 });
  } catch {}

  // 2) tenta clicar em seletores nos frames (onde for MESMA ORIGEM)
  for (const frame of page.frames()) {
    try {
      await frame.evaluate((sels) => {
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el) el.click();
        }
        document.body?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }, selectors);
    } catch {
      // cross-origin frame: sem acesso ao DOM → ignore
    }
  }

  // 3) tenta tocar qualquer <video> (muted) nos frames de mesma origem
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(() => {
        const vids = Array.from(document.querySelectorAll("video"));
        for (const v of vids) {
          try {
            v.muted = true;
            v.setAttribute("muted", "true");
            v.setAttribute("playsinline", "true");
            v.play().catch(() => {});
          } catch {}
        }
      });
    } catch {}
  }

  // 4) teclas comuns de play
  try { await page.keyboard.press(" "); } catch {}
  try { await page.keyboard.press("Enter"); } catch {}
  try { await page.keyboard.press("k"); } catch {}
}

async function extractM3U8FromPage(pageUrl) {
  if (!isAllowed(pageUrl)) throw new Error("Host não permitido para extração.");

  const browser = await puppeteer.launch({
    // usar “new headless” melhora compatibilidade em alguns sites
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1366,768",
      // reduz fingerprint de headless
      "--allow-running-insecure-content",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();

  // UA de desktop
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  });

  let m3u8 = null;

  // ===== LOGS ÚTEIS (veja na Koyeb) =====
  page.on("console", (msg) => console.log("[console]", msg.text()));
  page.on("pageerror", (err) => console.error("[pageerror]", err?.message || err));
  page.on("framenavigated", (frame) => {
    try { console.log("[frame]", frame.url()?.slice(0, 200)); } catch {}
  });

  // Captura .m3u8 por requests/responses (página + subframes)
  page.on("request", (req) => {
    const url = req.url();
    if (/\.m3u8(\?|$)/i.test(url)) {
      if (!m3u8) {
        m3u8 = url;
        console.log("[M3U8][request]", url);
      }
    }
  });
  page.on("response", (resp) => {
    const url = resp.url();
    if (/\.m3u8(\?|$)/i.test(url)) {
      if (!m3u8) {
        m3u8 = url;
        console.log("[M3U8][response]", url);
      }
    }
  });

  const GOTO_TIMEOUT = 30000;      // até 30s pra carregar o embed
  const GLOBAL_TIMEOUT = 120000;   // espera até 120s pelo .m3u8

  try {
    console.log("[goto]", pageUrl);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT });

    // Anti-bot comum: mascarar webdriver
    try {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
      });
    } catch {}

    // “Cutuca” o player e repete durante a espera
    const start = Date.now();
    await page.waitForTimeout(1200);
    await pokeAllFrames(page);

    while (!m3u8 && Date.now() - start < GLOBAL_TIMEOUT) {
      await page.waitForTimeout(500);
      // a cada ~3s tenta de novo (players que só liberam após gesto)
      if ((Date.now() - start) % 3000 < 600) {
        await pokeAllFrames(page);
      }
    }

    if (!m3u8) throw new Error(`Timed out after waiting ${GLOBAL_TIMEOUT}ms`);
    return m3u8;
  } finally {
    try { await ctx.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

/* ===== Rotas ===== */

app.get("/", (_req, res) => {
  res.type("html").send(`
    <h2>Gerador de Player (voodc → seu player)</h2>
    <ul>
      <li><code>/extract?url=https://voodc.com/...</code> → JSON com o .m3u8</li>
      <li><code>/make-player?url=https://voodc.com/...&title=Meu%20Canal</code> → HTML do seu player</li>
    </ul>
    <p style="font:14px system-ui;color:#888">Passe <b>url</b> em URL-encoded.</p>
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
  hls.on(Hls.Events.ERROR, (_, d) => console.warn("HLS error:", d.type, d.details));
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
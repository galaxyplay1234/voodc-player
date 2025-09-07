import express from "express";
import puppeteer from "puppeteer";
import qs from "qs";

const app = express();
const PORT = process.env.PORT || 3000;

// Permitir somente voodc (edite se usar outro host)
const ALLOWED_HOSTS = ["voodc.com", "www.voodc.com"];

function isAllowed(urlStr) {
  try { return ALLOWED_HOSTS.includes(new URL(urlStr).hostname); }
  catch { return false; }
}

async function extractM3U8FromPage(pageUrl) {
  if (!isAllowed(pageUrl)) throw new Error("Host não permitido.");

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  );

  let m3u8 = null;

  page.on("request", req => {
    const u = req.url();
    if (/\.m3u8(\?|$)/i.test(u) && !m3u8) m3u8 = u;
  });
  page.on("response", resp => {
    const u = resp.url();
    if (/\.m3u8(\?|$)/i.test(u) && !m3u8) m3u8 = u;
  });

  const GLOBAL_TIMEOUT = 20000;
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    const t0 = Date.now();
    while (!m3u8 && Date.now() - t0 < GLOBAL_TIMEOUT) {
      await page.waitForTimeout(400);
    }
    if (!m3u8) throw new Error("Não detectei .m3u8 na página.");
    return m3u8;
  } finally {
    await browser.close();
  }
}

// Rotas
app.get("/", (_, res) => {
  res.type("html").send(`
    <h2>Gerador de Player (voodc → seu player)</h2>
    <ul>
      <li><code>/extract?url=https://voodc.com/...</code> → retorna JSON com o .m3u8</li>
      <li><code>/make-player?url=https://voodc.com/...&title=Meu%20Canal</code> → responde HTML do seu player</li>
    </ul>
  `);
});

app.get("/extract", async (req, res) => {
  const pageUrl = req.query.url;
  if (!pageUrl) return res.status(400).json({ error: "Informe ?url=" });
  try {
    const m3u8 = await extractM3U8FromPage(pageUrl);
    res.json({ m3u8 });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
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
    const m3u8 = await extractM3U8FromPage(pageUrl);
    const query = qs.stringify({ m3u8, title });
    res.redirect(`/player?${query}`);
  } catch (e) {
    res.status(500).send("Falha ao extrair .m3u8: " + (e.message || e));
  }
});

app.listen(PORT, () => console.log("Rodando na porta", PORT));
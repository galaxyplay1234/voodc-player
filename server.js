import express from "express";
import morgan from "morgan";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

/** Permite só voodc (pode ampliar se precisar) */
const ALLOWED_HOSTS = ["voodc.com", "www.voodc.com"];

/** Hosts e pistas de ADS pra REMOVER do HTML */
const BLOCKED_HOST_PATTERNS = [
  /doubleclick\.net/i, /googlesyndication\.com/i, /google-analytics\.com/i,
  /adservice\.google\.com/i, /taboola|outbrain|mgid|revcontent/i,
  /propellerads|popcash|adnxs|rubiconproject|criteo/i
];
const BAD_DOM_SELECTORS = [
  "#ads",".ads","[id*='ad-']","[class*='ad-']",
  ".ad",".ad-container",".ad-slot",".advertisement",
  ".pop",".popup",".overlay",".modal-backdrop",".backdrop",
  ".banner","#banner",".cookie",".gdpr"
];

function isAllowed(urlStr){
  try { return ALLOWED_HOSTS.includes(new URL(urlStr).hostname); }
  catch { return false; }
}

function stripAds($) {
  // Remove <script> suspeitos por host/palavras-chave
  $("script").each((_, el) => {
    const src = $(el).attr("src") || "";
    const code = $(el).html() || "";
    const bad =
      BLOCKED_HOST_PATTERNS.some(rx => rx.test(src)) ||
      /ad(block|vert|s|unit)|popunder|banner|interstitial|taboola|outbrain|mgid|pushads/i.test(src+code);
    if (bad) $(el).remove();
  });

  // Remove iframes claramente de ads
  $("iframe").each((_, el) => {
    const src = $(el).attr("src") || "";
    if (BLOCKED_HOST_PATTERNS.some(rx => rx.test(src))) $(el).remove();
  });

  // Remove overlays genéricos
  $(BAD_DOM_SELECTORS.join(",")).remove();

  // Limpa handlers inline “suspeitos”
  $("[onclick*='ad'],[onload*='ad'],[onmouseover*='ad']").each((_, el) => {
    $(el).attr("onclick", null).attr("onload", null).attr("onmouseover", null);
  });
}

function injectBaseAndStyles($, baseUrl) {
  // Garante que URLs relativas continuem válidas
  const hasBase = $("head base").length > 0;
  if (!hasBase) {
    $("head").prepend(`<base href="${baseUrl}">`);
  } else {
    $("head base").attr("href", baseUrl);
  }

  // CSS pra fullscreen e sumir overlays remanescentes
  $("head").append(`
    <style>
      html,body{margin:0;padding:0;background:#000;height:100%}
      body,#app,#root{background:#000!important}
      iframe,video{width:100vw!important;height:100vh!important;border:0}
      .overlay,.modal,.modal-backdrop,.backdrop,.popup,.pop,.ads,.ad,.advert{display:none!important}
    </style>
  `);
}

/** Opcional: CSP leve (ligue com ?strict=1 se quiser testar) */
function maybeSetCSP(req, res) {
  if (String(req.query.strict||"") !== "1") return;
  const csp = [
    "default-src 'self' https: data: blob:",
    "img-src 'self' https: data: blob:",
    "style-src 'self' 'unsafe-inline' https:",
    "font-src 'self' https: data:",
    "media-src 'self' https: blob:",
    // Bem permissivo pra evitar tela preta; ajuste depois se quiser
    "connect-src * data: blob:",
    "frame-ancestors *",
    "frame-src * data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:",
    "block-all-mixed-content"
  ].join("; ");
  res.setHeader("Content-Security-Policy", csp);
}

/** Rota principal: limpa o embed */
app.get("/clean", async (req, res) => {
  const pageUrl = String(req.query.url || "");
  if (!pageUrl) return res.status(400).send("Use ?url=<embed do voodc>");
  if (!isAllowed(pageUrl)) return res.status(400).send("Host não permitido");

  try {
    const upstream = await fetch(pageUrl, { redirect: "follow" });
    if (!upstream.ok) return res.status(502).send("Upstream error: " + upstream.status);

    const finalUrl = upstream.url;            // após redirects
    const html = await upstream.text();
    const $ = cheerio.load(html, { decodeEntities:false });

    // 1) remove anúncios/overlays
    stripAds($);
    // 2) injeta <base> e CSS de tela cheia
    injectBaseAndStyles($, finalUrl);
    // 3) (opcional) CSP leve, só se pedir ?strict=1
    maybeSetCSP(req, res);

    // Cabeçalhos úteis
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");

    res.status(200).type("text/html; charset=utf-8").send($.html());
  } catch (e) {
    res.status(500).send("Clean error: " + (e?.message || e));
  }
});

/** Home */
app.get("/", (_req, res) => {
  res.type("html").send(`
    <h2>Voodc Clean Embed</h2>
    <p>Use: <code>/clean?url=https%3A%2F%2Fvoodc.com%2Fembed%2FSEU_ID.html</code></p>
    <p>Se a página ficar preta, teste <code>&strict=0</code> (padrão) e <code>&strict=1</code>.</p>
  `);
});

app.use(morgan("tiny"));
app.listen(PORT, () => console.log("Up on", PORT));
import express from "express";
import morgan from "morgan";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

/** Domínios permitidos para segurança (ajuste se precisar) */
const ALLOWED_HOSTS = ["voodc.com", "www.voodc.com"];

/** Domínios/trechos comuns de ADS para bloquear/remover */
const BLOCKED_HOST_PATTERNS = [
  /doubleclick\.net/i,
  /googlesyndication\.com/i,
  /google-analytics\.com/i,
  /adservice\.google\.com/i,
  /exosrv\.com|adskeeper|popcash|propellerads/i,
  /adnxs\.com|rubiconproject|criteo|taboola|outbrain/i,
  /revcontent|mgid|yahoo\.com\/ads/i,
  /push(crew|native|monetize|notifications)/i,
  /interstitial|adserver|banner|popunder/i
];

const BAD_DOM_SELECTORS = [
  "#ads", ".ads", "[id*='ad-']", "[class*='ad-']",
  ".ad", ".ad-container", ".ad-slot", ".advertisement",
  ".pop", ".popup", ".overlay", ".modal-backdrop", ".backdrop",
  ".banner", "#banner", ".cookie", ".gdpr"
];

function isAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    return ALLOWED_HOSTS.includes(u.hostname);
  } catch { return false; }
}

function absolutize(base, relative) {
  try { return new URL(relative, base).toString(); }
  catch { return relative; }
}

function isBlockedHost(urlStr) {
  try {
    const h = new URL(urlStr).hostname;
    return BLOCKED_HOST_PATTERNS.some(rx => rx.test(h));
  } catch { return false; }
}

function rewriteAttrs($, baseUrl) {
  const rewriteAttr = (el, attr) => {
    const val = $(el).attr(attr);
    if (!val) return;
    const abs = absolutize(baseUrl, val);

    if (isBlockedHost(abs)) { $(el).remove(); return; }
    if (/^https?:\/\//i.test(abs)) {
      $(el).attr(attr, "/p/" + encodeURIComponent(abs));
    }
  };

  $("img,script,link,iframe,source,video,audio").each((_, el) => rewriteAttr(el, "src"));
  $("link").each((_, el) => rewriteAttr(el, "href"));

  $("img[srcset]").each((_, el) => {
    const parts = ($(el).attr("srcset") || "").split(",").map(s => s.trim()).filter(Boolean);
    const newParts = parts.map(p => {
      const [u, size] = p.split(/\s+/);
      const abs = absolutize(baseUrl, u);
      if (isBlockedHost(abs)) return "";
      if (/^https?:\/\//i.test(abs)) return "/p/" + encodeURIComponent(abs) + (size ? (" " + size) : "");
      return p;
    }).filter(Boolean);
    $(el).attr("srcset", newParts.join(", "));
  });
}

function stripAds($) {
  $("script").each((_, el) => {
    const src = $(el).attr("src") || "";
    const code = $(el).html() || "";
    const looksBad =
      isBlockedHost(src) ||
      /ad(block|vert|s|unit)|popunder|banner|interstitial|taboola|outbrain|mgid|pushads/i.test(src) ||
      /ad(block|vert|s|unit)|popunder|banner|interstitial|taboola|outbrain|mgid|pushads/i.test(code);
    if (looksBad) $(el).remove();
  });

  $(BAD_DOM_SELECTORS.join(",")).remove();
  $("[onclick*='ad'], [onload*='ad'], [onmouseover*='ad']").each((_, el) => {
    $(el).attr("onclick", null).attr("onload", null).attr("onmouseover", null);
  });

  $("head").append(`
    <style>
      .overlay, .modal, .modal-backdrop, .backdrop, .popup, .pop, .ads, .ad, .advert { display:none !important; }
      html, body { margin:0; padding:0; background:#000; height:100%; }
      body, #app, #root { background:#000 !important; }
      iframe, video { width:100vw !important; height:100vh !important; }
    </style>
  `);
}

function setCSP(res) {
  const csp = [
    "default-src 'self' https: data: blob:",
    "img-src 'self' https: data: blob:",
    "style-src 'self' 'unsafe-inline' https:",
    "font-src 'self' https: data:",
    "media-src 'self' https: blob:",
    "connect-src 'self' https://voodc.com https://www.voodc.com https://*.voodc.com",
    "frame-ancestors *",
    "frame-src 'self' https://voodc.com https://www.voodc.com https://*.voodc.com",
    "script-src 'self' 'unsafe-inline' https://voodc.com https://www.voodc.com https://*.voodc.com",
    "block-all-mixed-content"
  ].join("; ");
  res.setHeader("Content-Security-Policy", csp);
}

/** Proxy de assets */
app.get("/p/:url", async (req, res) => {
  const target = req.params.url ? decodeURIComponent(req.params.url) : "";
  try {
    if (isBlockedHost(target)) return res.status(403).send("Blocked host");
    const r = await fetch(target, { redirect: "follow" });
    res.status(r.status);
    const ct = r.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    res.setHeader("Cache-Control", "public, max-age=60");
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch {
    res.status(500).send("Asset proxy error");
  }
});

/** Página limpa do embed */
app.get("/clean", async (req, res) => {
  const pageUrl = String(req.query.url || "");
  if (!pageUrl) return res.status(400).send("Use ?url=<embed do voodc>");
  if (!isAllowed(pageUrl)) return res.status(400).send("Host não permitido");

  try {
    const upstream = await fetch(pageUrl, { redirect: "follow" });
    if (!upstream.ok) return res.status(502).send("Upstream error: " + upstream.status);

    const base = upstream.url; // após redirects
    const html = await upstream.text();
    const $ = cheerio.load(html, { decodeEntities: false });

    stripAds($);
    rewriteAttrs($, base);
    setCSP(res);

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
    <p>Dica: passe a URL em <b>URL-encoded</b>.</p>
  `);
});

app.use(morgan("tiny"));
app.listen(PORT, () => console.log("Up on", PORT));
import express from "express";
import fetch from "node-fetch";
import morgan from "morgan";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

/** Domínios permitidos para segurança (ajuste se precisar) */
const ALLOWED_HOSTS = [
  "voodc.com",
  "www.voodc.com"
];

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

/** classes/ids sugestivas de overlay/ads no DOM */
const BAD_DOM_SELECTORS = [
  "#ads", ".ads", "[id*='ad-']", "[class*='ad-']",
  ".ad", ".ad-container", ".ad-slot", ".advertisement",
  ".pop", ".popup", ".overlay", ".modal-backdrop", ".backdrop",
  ".banner", "#banner", ".cookie", ".gdpr"
];

/** Checa se a URL é permitida */
function isAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    return ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

/** Constrói URL absoluta a partir de base + caminho relativo */
function absolutize(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

/** Verifica se uma URL aponta para host bloqueado */
function isBlockedHost(urlStr) {
  try {
    const h = new URL(urlStr).hostname;
    return BLOCKED_HOST_PATTERNS.some(rx => rx.test(h));
  } catch {
    return false;
  }
}

/** Reescreve atributos (src/href/srcset) para passar pelo nosso proxy /p/ */
function rewriteAttrs($, baseUrl) {
  const rewrite = (i, el, attr) => {
    const val = $(el).attr(attr);
    if (!val) return;
    const abs = absolutize(baseUrl, val);

    // se for host bloqueado → remove
    if (isBlockedHost(abs)) {
      $(el).remove();
      return;
    }
    // só reescreve se for http(s)
    if (/^https?:\/\//i.test(abs)) {
      const prox = "/p/" + encodeURIComponent(abs);
      $(el).attr(attr, prox);
    }
  };

  $("img,script,link,iframe,source,video,audio").each((i, el) => rewrite(i, el, "src"));
  $("link").each((i, el) => rewrite(i, el, "href"));

  // srcset (imagens responsivas)
  $("img[srcset]").each((i, el) => {
    const srcset = $(el).attr("srcset");
    const parts = (srcset || "").split(",").map(s => s.trim()).filter(Boolean);
    const newParts = parts.map(p => {
      const [u, size] = p.split(/\s+/);
      const abs = absolutize(baseUrl, u);
      if (isBlockedHost(abs)) return "";
      if (/^https?:\/\//i.test(abs)) {
        return ("/p/" + encodeURIComponent(abs)) + (size ? (" " + size) : "");
      }
      return p;
    }).filter(Boolean);
    $(el).attr("srcset", newParts.join(", "));
  });
}

/** Remove scripts e elementos suspeitos de ads/overlays */
function stripAds($) {
  // remove scripts com hosts bloqueados ou com palavras-chave de ads
  $("script").each((i, el) => {
    const src = $(el).attr("src") || "";
    const code = $(el).html() || "";
    const looksBad =
      isBlockedHost(src) ||
      /ad(block|vert|s|unit)|popunder|banner|interstitial|taboola|outbrain|mgid|pushads/i.test(src) ||
      /ad(block|vert|s|unit)|popunder|banner|interstitial|taboola|outbrain|mgid|pushads/i.test(code);

    if (looksBad) $(el).remove();
  });

  // remove elementos por seletores genéricos
  $(BAD_DOM_SELECTORS.join(",")).remove();

  // remove inline handlers suspeitos
  $("[onclick*='ad'], [onload*='ad'], [onmouseover*='ad']").each((i, el) => {
    $(el).attr("onclick", null);
    $(el).attr("onload", null);
    $(el).attr("onmouseover", null);
  });

  // CSS para garantir que overlays restantes fiquem invisíveis
  $("head").append(`
    <style>
      .overlay, .modal, .modal-backdrop, .backdrop, .popup, .pop, .ads, .ad, .advert { display:none !important; }
      body { overflow:auto !important; }
    </style>
  `);
}

/** Insere uma Content-Security-Policy para bloquear requisições a domínios de ads */
function setCSP(res) {
  // libera voodc e self; bloqueia de resto via connect-src/img-src/frame-src/script-src
  const csp = [
    "default-src 'self' https: data: blob:",
    "img-src 'self' https: data: blob:",
    "style-src 'self' 'unsafe-inline' https:",
    "font-src 'self' https: data:",
    "media-src 'self' https: blob:",
    "connect-src 'self' https://voodc.com https://www.voodc.com https://*.voodc.com",
    "frame-ancestors *", // permite incorporar
    "frame-src 'self' https://voodc.com https://www.voodc.com https://*.voodc.com",
    "script-src 'self' 'unsafe-inline' https://voodc.com https://www.voodc.com https://*.voodc.com",
    // opcional: bloqueios explícitos
    "block-all-mixed-content"
  ].join("; ");
  res.setHeader("Content-Security-Policy", csp);
}

/** Proxy simples de assets estáticos */
app.get("/p/:url", async (req, res) => {
  const target = req.params.url ? decodeURIComponent(req.params.url) : "";
  try {
    const u = new URL(target);
    // se asset vier de host bloqueado → 403
    if (isBlockedHost(target)) return res.status(403).send("Blocked host");
    const r = await fetch(u, { redirect: "follow" });
    res.status(r.status);
    // repassa content-type
    const ct = r.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    // cache curto
    res.setHeader("Cache-Control", "public, max-age=60");
    const buf = await r.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).send("Asset proxy error");
  }
});

/** Página limpa: /clean?url=<URL do embed voodc> */
app.get("/clean", async (req, res) => {
  const pageUrl = String(req.query.url || "");
  if (!pageUrl) return res.status(400).send("Use ?url=<embed do voodc>");
  if (!isAllowed(pageUrl)) return res.status(400).send("Host não permitido");

  try {
    const upstream = await fetch(pageUrl, { redirect: "follow" });
    if (!upstream.ok) {
      return res.status(502).send("Upstream error: " + upstream.status);
    }
    const base = upstream.url; // pode ter sido redirecionado
    let html = await upstream.text();

    // carrega no cheerio
    const $ = cheerio.load(html, { decodeEntities: false });

    // remove anúncios e overlays
    stripAds($);

    // reescreve atributos para nosso proxy de assets
    rewriteAttrs($, base);

    // injeta uma correção visual mínima
    $("head").append(`
      <style>
        html, body { margin:0; padding:0; background:#000; height:100%; }
        body, #app, #root { background:#000 !important; }
        iframe, video { width:100vw !important; height:100vh !important; }
      </style>
    `);

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
app.get("/", (req, res) => {
  res.type("html").send(`
    <h2>Voodc Clean Embed</h2>
    <p>Use: <code>/clean?url=https%3A%2F%2Fvoodc.com%2Fembed%2FSUA_PAGINA.html</code></p>
    <p>Dica: passe a URL em <b>URL-encoded</b>.</p>
  `);
});

app.use(morgan("tiny"));
app.listen(PORT, () => console.log("Up on", PORT));
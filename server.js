import express from "express";
import morgan from "morgan";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

/** Permita voodc (ajuste se precisar) */
const ALLOWED_HOSTS = new Set(["voodc.com", "www.voodc.com"]);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Seletores e padrões simples de anúncios/overlays */
const AD_HOSTS = [
  /doubleclick\.net/i, /googlesyndication\.com/i, /google-analytics\.com/i,
  /adservice\.google\.com/i, /taboola|outbrain|mgid|revcontent/i,
  /propellerads|popcash|adnxs|rubiconproject|criteo/i
];
const AD_SELECTORS = [
  "#ads",".ads","[id*='ad-']","[class*='ad-']",".ad",".ad-container",".ad-slot",
  ".advertisement",".pop",".popup",".overlay",".modal-backdrop",".backdrop",
  ".banner","#banner",".cookie",".gdpr"
];

function isAllowed(urlStr) {
  try {
    const h = new URL(urlStr).hostname;
    return ALLOWED_HOSTS.has(h);
  } catch {
    return false;
  }
}
function isAdHost(urlStr) {
  try {
    const h = new URL(urlStr).hostname;
    return AD_HOSTS.some(rx => rx.test(h));
  } catch { return false; }
}
function absolutize(base, rel) {
  try { return new URL(rel, base).toString(); }
  catch { return rel; }
}

/** Proxy genérico de QUALQUER recurso (HTML/JS/CSS/img/m3u8/TS/...) */
app.get("/pipe", async (req, res) => {
  const u = String(req.query.u || "");
  if (!u) return res.status(400).send("Use ?u=<URL>");
  if (!isAllowed(u)) return res.status(400).send("Host não permitido");

  try {
    const upstream = await fetch(u, {
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        "Referer": "https://voodc.com/",
        "Origin": "https://voodc.com",
        "Accept": "*/*",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    // Copia status e alguns headers, mas remove bloqueios
    res.status(upstream.status);
    const skip = new Set([
      "content-security-policy",
      "x-frame-options",
      "cross-origin-embedder-policy",
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
      "permissions-policy",
      "referrer-policy",
      "report-to"
    ]);
    for (const [k, v] of upstream.headers.entries()) {
      if (!skip.has(k.toLowerCase())) res.setHeader(k, v);
    }

    // Stream direta do corpo (funciona para binários e textos)
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).send("Pipe error: " + (e?.message || e));
  }
});

/** Reescreve TODO HTML para carregar TUDO via /pipe (mesma origem) e limpa ads */
function rewriteHtmlToProxy(html, baseUrl, clean = true) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Remove <meta http-equiv="Content-Security-Policy"> se houver
  $("meta[http-equiv='Content-Security-Policy']").remove();

  // Limpa anúncios (se clean = true)
  if (clean) {
    $("script").each((_, el) => {
      const src = $(el).attr("src") || "";
      const code = $(el).html() || "";
      const bad = isAdHost(src) ||
        /ad(block|vert|s|unit)|popunder|banner|interstitial|taboola|outbrain|mgid|pushads/i.test(src+code);
      if (bad) $(el).remove();
    });
    $("iframe").each((_, el) => {
      const src = $(el).attr("src") || "";
      if (isAdHost(src)) $(el).remove();
    });
    $(AD_SELECTORS.join(",")).remove();
  }

  // Força full-screen visual
  $("head").prepend(`<base href="${baseUrl}">`);
  $("head").append(`
    <style>
      html,body{margin:0;padding:0;background:#000;height:100%}
      body,#app,#root{background:#000!important}
      iframe,video{width:100vw!important;height:100vh!important;border:0}
    </style>
  `);

  // Reescreve todos os atributos que podem puxar rede
  const rewriteAttr = (el, attr) => {
    const val = $(el).attr(attr);
    if (!val) return;
    const abs = absolutize(baseUrl, val);
    // As chamadas passam por /pipe?u=...
    $(el).attr(attr, "/pipe?u=" + encodeURIComponent(abs));
  };

  $("script,link,iframe,img,source,video,audio").each((_, el) => {
    const tag = el.tagName?.toLowerCase?.() || el.name;
    if (tag === "link") rewriteAttr(el, "href");
    rewriteAttr(el, "src");
    // srcset
    if ($(el).attr("srcset")) {
      const parts = ($(el).attr("srcset") || "").split(",").map(s => s.trim()).filter(Boolean);
      const out = parts.map(p => {
        const [u, size] = p.split(/\s+/);
        const abs = absolutize(baseUrl, u);
        return "/pipe?u=" + encodeURIComponent(abs) + (size ? (" " + size) : "");
      });
      $(el).attr("srcset", out.join(", "));
    }
  });

  // Reescreve <a href> para ficar dentro do proxy (navegação)
  $("a[href]").each((_, el) => rewriteAttr(el, "href"));

  // Injeta um pequeno helper para clicks que gerem novas janelas/iframes
  $("body").append(`
    <script>
      // Garante que fetches dinâmicos por JS usando URL relativa continuem funcionando
      // (como já temos <base>, na maioria dos casos fica ok)
      console.log("Proxy HTML reescrito via /pipe, base:", ${JSON.stringify(baseUrl)});
    </script>
  `);

  return $.html();
}

/** /clean → reescreve TUDO para /pipe e remove anúncios */
app.get("/clean", async (req, res) => {
  const u = String(req.query.u || req.query.url || "");
  if (!u) return res.status(400).send("Use ?u=<embed do voodc>");
  if (!isAllowed(u)) return res.status(400).send("Host não permitido");

  try {
    const upstream = await fetch(u, {
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        "Referer": "https://voodc.com/",
        "Origin": "https://voodc.com",
        "Accept": "text/html,*/*",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    if (!upstream.ok) return res.status(502).send("Upstream error: " + upstream.status);
    const finalUrl = upstream.url;
    const ct = upstream.headers.get("content-type") || "";
    if (!/html/i.test(ct)) {
      // Se não for HTML, devolve via pipe
      res.redirect("/pipe?u=" + encodeURIComponent(finalUrl));
      return;
    }

    const html = await upstream.text();
    const rewritten = rewriteHtmlToProxy(html, finalUrl, /*clean=*/true);

    // Cabeçalhos sem bloqueios
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(rewritten);
  } catch (e) {
    res.status(500).send("Clean error: " + (e?.message || e));
  }
});

/** Página inicial */
app.get("/", (_req, res) => {
  res.type("html").send(`
    <h2>Voodc Reverse Proxy</h2>
    <p>Abra (URL-encoded):</p>
    <ul>
      <li><code>/pipe?u=https%3A%2F%2Fvoodc.com%2Fembed%2FSEU_ID.html</code> (proxy puro)</li>
      <li><code>/clean?u=https%3A%2F%2Fvoodc.com%2Fembed%2FSEU_ID.html</code> (proxy com limpeza de ads)</li>
    </ul>
  `);
});

app.use(morgan("tiny"));
app.listen(PORT, () => console.log("Up on", PORT));
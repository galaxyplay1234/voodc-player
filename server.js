import express from "express";
import morgan from "morgan";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

// UA de navegador desktop comum
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// padrões de anúncios (apenas para ocultar/retirar iframes de ads)
const AD_HOSTS = [
  /doubleclick\.net/i, /googlesyndication\.com/i, /google-analytics\.com/i,
  /adservice\.google\.com/i, /taboola|outbrain|mgid|revcontent/i,
  /propellerads|popcash|adnxs|rubiconproject|criteo/i
];
const AD_SELECTORS = [
  "#ads",".ads","[id*='ad-']","[class*='ad-']",
  ".ad",".ad-container",".ad-slot",".advertisement",
  ".pop",".popup",".overlay",".modal-backdrop",".backdrop",
  ".banner","#banner",".cookie",".gdpr"
];

function absolutize(base, rel){ try{ return new URL(rel, base).toString(); }catch{ return rel; } }
function isAdHost(urlStr){ try{ return AD_HOSTS.some(rx => rx.test(new URL(urlStr).hostname)); }catch{ return false; } }

/** Proxy universal: entrega qualquer recurso como se fosse local */
app.get("/pipe", async (req, res) => {
  const u = String(req.query.u || "");
  if (!u) return res.status(400).send("Use ?u=<URL>");

  try {
    const upstream = await fetch(u, {
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        // referer/origin: ajudam se o site exigir
        "Referer": new URL(u).origin + "/",
        "Origin": new URL(u).origin,
        "Accept": "*/*",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    res.status(upstream.status);

    // Copia headers úteis, mas remove os que bloqueiam em iframe/proxy
    const skip = new Set([
      "content-security-policy","x-frame-options",
      "cross-origin-embedder-policy","cross-origin-opener-policy","cross-origin-resource-policy",
      "permissions-policy","referrer-policy","report-to"
    ]);
    for (const [k, v] of upstream.headers.entries()) {
      if (!skip.has(k.toLowerCase())) res.setHeader(k, v);
    }

    // Stream do corpo
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).send("Pipe error: " + (e?.message || e));
  }
});

/** Reescreve todo HTML para que TUDO carregue via /pipe (mesma origem) */
function rewriteHtml(html, baseUrl, hideAds = true) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // remove CSP por meta tag
  $("meta[http-equiv='Content-Security-Policy']").remove();

  // base para manter relativas coerentes (ainda assim vamos reescrever)
  if ($("head base").length) $("head base").attr("href", baseUrl);
  else $("head").prepend(`<base href="${baseUrl}">`);

  // full screen + ocultar overlays comuns
  $("head").append(`
    <style>
      html,body{margin:0;padding:0;background:#000;height:100%}
      body,#app,#root{background:#000!important}
      iframe,video{width:100vw!important;height:100vh!important;border:0}
      ${hideAds ? ".overlay,.modal,.modal-backdrop,.backdrop,.popup,.pop,.ads,.ad,.advert{display:none!important}" : ""}
    </style>
  `);

  // Se hideAds: remove apenas iframes de hosts de ad (não mexe nos scripts do player!)
  if (hideAds) {
    $("iframe").each((_, el) => {
      const src = $(el).attr("src") || "";
      if (isAdHost(src)) $(el).remove();
    });
  }

  // Reescreve atributos para passar por /pipe
  const rewriteAttr = (el, attr) => {
    const val = $(el).attr(attr);
    if (!val) return;
    const abs = absolutize(baseUrl, val);
    if (/^https?:\/\//i.test(abs)) $(el).attr(attr, "/pipe?u=" + encodeURIComponent(abs));
  };

  $("script,link,iframe,img,source,video,audio").each((_, el) => {
    const tag = el.tagName?.toLowerCase?.() || el.name;
    if (tag === "link") rewriteAttr(el, "href");
    rewriteAttr(el, "src");
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

  // Links de navegação também vão para /pipe
  $("a[href]").each((_, el) => rewriteAttr(el, "href"));

  return $.html();
}

/** Página limpa do voodc, reescrita para o proxy e sem anúncios */
app.get("/clean", async (req, res) => {
  const u = String(req.query.u || req.query.url || "");
  if (!u) return res.status(400).send("Use ?u=<embed do voodc>");
  // (Sem whitelist de host: o voodc costuma usar CDNs/hosts diversos; deixamos universal)

  try {
    const upstream = await fetch(u, {
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        "Referer": new URL(u).origin + "/",
        "Origin": new URL(u).origin,
        "Accept": "text/html,*/*",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    if (!upstream.ok) return res.status(502).send("Upstream error: " + upstream.status);
    const finalUrl = upstream.url;
    const ct = upstream.headers.get("content-type") || "";

    // Se não for HTML, manda pelo /pipe
    if (!/html/i.test(ct)) return res.redirect("/pipe?u=" + encodeURIComponent(finalUrl));

    const html = await upstream.text();
    const rewritten = rewriteHtml(html, finalUrl, /*hideAds=*/true);

    // Cabeçalhos sem bloqueio
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Cache-Control", "no-store");
    // CSP propositalmente ausente (pra não quebrar scripts do player)
    res.status(200).send(rewritten);
  } catch (e) {
    res.status(500).send("Clean error: " + (e?.message || e));
  }
});

/** Home */
app.get("/", (_req, res) => {
  res.type("html").send(`
    <h2>Voodc Player (sem anúncios)</h2>
    <p>Abrir (URL-encoded):</p>
    <ul>
      <li><code>/clean?u=https%3A%2F%2Fvoodc.com%2Fembed%2FSEU_ID.html</code> &larr; usa o MESMO player, sem anúncios</li>
      <li><code>/pipe?u=https%3A%2F%2Fvoodc.com%2Fembed%2FSEU_ID.html</code> &larr; proxy puro (debug)</li>
    </ul>
  `);
});

app.use(morgan("tiny"));
app.listen(PORT, () => console.log("Up on", PORT));
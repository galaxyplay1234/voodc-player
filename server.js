import express from "express";
import morgan from "morgan";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Apenas ESCONDER ads visualmente. Não removemos scripts do player.
const HIDE_OVERLAYS_CSS = `
  .overlay,.modal,.modal-backdrop,.backdrop,.popup,.pop,.ads,.ad,.advert{display:none!important}
`;

function absolutize(base, rel){
  // trata URLs relativas e também //host/path (protocol-relative)
  try {
    const fixed = rel?.startsWith?.("//") ? ("https:" + rel) : rel;
    return new URL(fixed, base).toString();
  } catch {
    return rel;
  }
}

/* ====================== PROXY UNIVERSAL ====================== */
app.get("/pipe", async (req, res) => {
  const u = String(req.query.u || "");
  if (!u) return res.status(400).send("Use ?u=<URL>");

  try {
    const url = new URL(u); // também valida
    const upstream = await fetch(u, {
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        "Referer": url.origin + "/",
        "Origin": url.origin,
        "Accept": "*/*",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    res.status(upstream.status);

    // Copia headers úteis e REMOVE os que bloqueiam em iframe/proxy
    const skip = new Set([
      "content-security-policy","x-frame-options",
      "cross-origin-embedder-policy","cross-origin-opener-policy","cross-origin-resource-policy",
      "permissions-policy","referrer-policy","report-to","accept-ch"
    ]);
    for (const [k, v] of upstream.headers.entries()) {
      if (!skip.has(k.toLowerCase())) res.setHeader(k, v);
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).send("Pipe error: " + (e?.message || e));
  }
});

/* ===== reescrita estática de atributos e injeção de HOOK dinâmico ===== */
function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // remove CSP por meta e força <base>
  $("meta[http-equiv='Content-Security-Policy']").remove();
  if ($("head base").length) $("head base").attr("href", baseUrl);
  else $("head").prepend(`<base href="${baseUrl}">`);

  // fullscreen + esconder overlays (sem tocar no player)
  $("head").append(`
    <style>
      html,body{margin:0;padding:0;background:#000;height:100%}
      body,#app,#root{background:#000!important}
      iframe,video{width:100vw!important;height:100vh!important;border:0}
      ${HIDE_OVERLAYS_CSS}
    </style>
  `);

  // Reescrita ESTÁTICA inicial
  const rewriteAttr = (el, attr) => {
    const val = $(el).attr(attr);
    if (!val) return;
    const abs = absolutize(baseUrl, val);
    if (/^https?:\/\//i.test(abs)) {
      $(el).attr(attr, "/pipe?u=" + encodeURIComponent(abs));
    }
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

  $("a[href]").each((_, el) => rewriteAttr(el, "href"));

  // Injeção de HOOK: intercepta TUDO criado depois (document.write, createElement, setAttribute, fetch, XHR, appendChild…)
  $("body").append(`
<script>
(function(){
  const BASE = ${JSON.stringify(baseUrl)};
  const toAbs = (url) => {
    try {
      if (!url) return url;
      if (url.startsWith("//")) url = "https:" + url;
      return new URL(url, BASE).toString();
    } catch { return url; }
  };
  const prox = (url) => {
    try {
      const abs = toAbs(url);
      if (/^https?:\\/\\//i.test(abs)) return "/pipe?u=" + encodeURIComponent(abs);
      return url;
    } catch { return url; }
  };

  // Reescreve URLs em HTML string (para document.write)
  const rewriteHtmlUrls = (s) => {
    try {
      return s
        // src="..." | href="..."
        .replace(/\\b(src|href)=(["'])([^"']+)\\2/gi, (m,attr,q,v)=> attr+"="+q+prox(v)+q)
        // srcset="u1 1x, u2 2x"
        .replace(/\\bsrcset=(["'])([^"']+)\\1/gi, (m,q,val)=>{
          const out = val.split(",").map(p=>{
            const parts = p.trim().split(/\\s+/);
            const u = parts.shift();
            const rest = parts.join(" ");
            return prox(u) + (rest?(" "+rest):"");
          });
          return 'srcset=' + q + out.join(", ") + q;
        });
    } catch { return s; }
  };

  // document.write / writeln
  const _write = document.write.bind(document);
  const _writeln = document.writeln.bind(document);
  document.write = function(...args){ _write(rewriteHtmlUrls(args.join(""))); };
  document.writeln = function(...args){ _writeln(rewriteHtmlUrls(args.join(""))); };

  // createElement + setAttribute + propriedades .src/.href
  const _createElement = document.createElement.bind(document);
  document.createElement = function(tag){
    const el = _createElement(tag);
    try {
      const _setAttr = el.setAttribute?.bind(el);
      el.setAttribute = function(name, value){
        if (["src","href","srcset","data"].includes(String(name).toLowerCase())) {
          if (name.toLowerCase()==="srcset") {
            const out = String(value).split(",").map(p=>{
              const parts = p.trim().split(/\\s+/);
              const u = parts.shift();
              const rest = parts.join(" ");
              return prox(u) + (rest?(" "+rest):"");
            }).join(", ");
            return _setAttr(name, out);
          }
          return _setAttr(name, prox(String(value)));
        }
        return _setAttr(name, value);
      };

      // defineProperty para .src/.href
      ["src","href"].forEach(prop=>{
        if (prop in el) {
          const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), prop) || {};
          const _set = desc.set?.bind(el) || function(v){ _setAttr(prop, v); };
          Object.defineProperty(el, prop, {
            set(v){ _set(prox(String(v))); },
            get(){ return (desc.get?.bind(el) || (()=>el.getAttribute(prop)))(); }
          });
        }
      });
    } catch {}
    return el;
  };

  // fetch
  const _fetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    try {
      if (typeof input === "string") input = prox(input);
      else if (input && input.url) input = prox(input.url);
    } catch {}
    return _fetch(input, init);
  };

  // XHR
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest){
    try { url = prox(String(url)); } catch {}
    return _open.call(this, method, url, ...rest);
  };

  // Intercepta nós inseridos dinamicamente (appendChild/insertBefore + MutationObserver)
  const rewriteNode = (node)=>{
    try {
      if (!node || !node.tagName) return;
      const attrs = ["src","href","srcset"];
      for (const a of attrs) {
        if (node.hasAttribute && node.hasAttribute(a)) {
          const v = node.getAttribute(a);
          node.setAttribute(a, v); // dispara nosso setAttribute hook
        }
      }
    } catch {}
  };

  const _appendChild = Element.prototype.appendChild;
  Element.prototype.appendChild = function(n){ rewriteNode(n); return _appendChild.call(this, n); };
  const _insertBefore = Element.prototype.insertBefore;
  Element.prototype.insertBefore = function(n, ref){ rewriteNode(n); return _insertBefore.call(this, n, ref); };

  new MutationObserver(muts=>{
    muts.forEach(m=>{
      m.addedNodes && m.addedNodes.forEach(rewriteNode);
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  console.log("Proxy hook ativo. Base:", BASE);
})();
</script>`);

  return $.html();
}

/* =========================== /clean =========================== */
app.get("/clean", async (req, res) => {
  const u = String(req.query.u || req.query.url || "");
  if (!u) return res.status(400).send("Use ?u=<embed do voodc>");

  try {
    const url = new URL(u);
    const upstream = await fetch(u, {
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        "Referer": url.origin + "/",
        "Origin": url.origin,
        "Accept": "text/html,*/*",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    if (!upstream.ok) return res.status(502).send("Upstream error: " + upstream.status);

    const finalUrl = upstream.url;
    const ct = upstream.headers.get("content-type") || "";
    if (!/html/i.test(ct)) return res.redirect("/pipe?u=" + encodeURIComponent(finalUrl));

    const html = await upstream.text();
    const rewritten = rewriteHtml(html, finalUrl);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(rewritten);
  } catch (e) {
    res.status(500).send("Clean error: " + (e?.message || e));
  }
});

/* =========================== HOME ============================ */
app.get("/", (_req, res) => {
  res.type("html").send(`
    <h2>Voodc Player (sem anúncios)</h2>
    <p>Abra (URL-encoded):</p>
    <ul>
      <li><code>/clean?u=https%3A%2F%2Fvoodc.com%2Fembed%2FSEU_ID.html</code></li>
      <li><code>/pipe?u=https%3A%2F%2Fvoodc.com%2Fembed%2FSEU_ID.html</code> (debug)</li>
    </ul>
  `);
});

app.use(morgan("tiny"));
app.listen(PORT, () => console.log("Up on", PORT));
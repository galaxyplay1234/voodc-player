import express from "express";
import morgan from "morgan";
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(morgan("tiny"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const channels = new Map();

const hostOf = (req) => `${req.protocol}://${req.get("host")}`;
const abs = (base, rel) => { try { if (!rel) return rel; if (rel.startsWith("//")) return "https:"+rel; return new URL(rel, base).toString(); } catch { return rel; } };
const slugify = (s) => (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"") || "canal";
const uniqueName = (b) => { let n=slugify(b); if(!channels.has(n)) return n; let i=2; while(channels.has(`${n}-${i}`)) i++; return `${n}-${i}`; };
async function fetchText(url){
  const r = await fetch(url,{redirect:"follow",headers:{"User-Agent":UA,"Referer":new URL(url).origin+"/","Origin":new URL(url).origin,"Accept":"application/vnd.apple.mpegurl,*/*;q=0.8","Cache-Control":"no-cache"}});
  if(!r.ok) throw new Error("Upstream "+r.status);
  return { base:r.url, text:await r.text() };
}

app.get("/",(_req,res)=>res.type("text/plain").send(
`HLS repeater ON

Rotas:
- GET  /add?m3u8=<URL-ENC>&name=<nome>      (repita pares p/ vários)
- POST /add_json { "items":[{"m3u8":"...","name":"canal1"}, ...] }
- GET  /list
- GET  /update?name=<nome>&m3u8=<URL-ENC>
- GET  /rename?old=<nome>&next=<novo>
- GET  /remove?name=<nome>
- GET  /diag/<nome>
- GET  /hls/<nome>.m3u8
- GET  /seg/<nome>?u=<URL-ABS>`));

/* cadastrar */
app.get("/add",(req,res)=>{
  let urls=req.query.m3u8, names=req.query.name;
  if(!urls) return res.status(400).send("Use ?m3u8=<URL-ENC>&name=<apelido>");
  if(!Array.isArray(urls)) urls=[urls];
  if(names===undefined) names=[]; if(!Array.isArray(names)) names=[names];
  const out=[];
  for(let i=0;i<urls.length;i++){
    const src=String(urls[i]); const raw=names[i]??""; const name=raw?uniqueName(raw):uniqueName("canal");
    channels.set(name,{src}); out.push(`${hostOf(req)}/hls/${name}.m3u8`);
  }
  res.type("text/plain").send(out.join("\n")+"\n");
});
app.post("/add_json",(req,res)=>{
  const items=Array.isArray(req.body?.items)?req.body.items:[];
  if(items.length===0) return res.status(400).json({error:"Envie { items:[{m3u8,name},...] }"});
  const out=[]; for(const it of items){ if(!it?.m3u8) continue; const name=it?.name?uniqueName(String(it.name)):uniqueName("canal"); channels.set(name,{src:String(it.m3u8)}); out.push({name,url:`${hostOf(req)}/hls/${name}.m3u8`}); }
  res.json({ok:true,links:out});
});

/* gerenciar */
app.get("/list",(req,res)=>res.json([...channels.entries()].map(([name,{src}])=>({name,src,url:`${hostOf(req)}/hls/${name}.m3u8`}))));
app.get("/update",(req,res)=>{const name=slugify(String(req.query.name||"")); const m3u8=String(req.query.m3u8||""); if(!name||!m3u8) return res.status(400).send("Use ?name=<nome>&m3u8=<URL-ENC>"); const ch=channels.get(name); if(!ch) return res.status(404).send("nome não encontrado"); ch.src=m3u8; res.type("text/plain").send(`OK atualizado: ${hostOf(req)}/hls/${name}.m3u8\n`);});
app.get("/rename",(req,res)=>{const old=slugify(String(req.query.old||"")); let next=slugify(String(req.query.next||"")); if(!old||!next) return res.status(400).send("Use ?old=<nome-atual>&next=<novo>"); if(!channels.has(old)) return res.status(404).send("nome atual não encontrado"); if(channels.has(next)) next=uniqueName(next); const data=channels.get(old); channels.delete(old); channels.set(next,data); res.type("text/plain").send(`OK renomeado: ${old} -> ${next}\n${hostOf(req)}/hls/${next}.m3u8\n`);});
app.get("/remove",(req,res)=>{const name=slugify(String(req.query.name||"")); if(!name) return res.status(400).send("Use ?name=<nome>"); const ok=channels.delete(name); res.type("text/plain").send(ok?"OK removido\n":"nome não encontrado\n");});

/* diag */
app.get("/diag/:name",async (req,res)=>{ const name=slugify(req.params.name||""); const ch=channels.get(name); if(!ch) return res.status(404).send("Canal não encontrado"); try{ const r=await fetch(ch.src,{redirect:"follow",headers:{"User-Agent":UA,"Accept":"application/vnd.apple.mpegurl,*/*;q=0.8","Referer":new URL(ch.src).origin+"/","Origin":new URL(ch.src).origin}}); const head=`UPSTREAM ${r.status} ${r.statusText}\nURL: ${r.url}\nCT: ${r.headers.get("content-type")}\n`; const body=await r.text(); res.type("text/plain").send(head+"\n"+body.slice(0,1200)); }catch(e){ res.status(502).type("text/plain").send("Erro upstream: "+(e?.message||e)); }});

/* playlists: master + sub-playlists */
app.get("/hls/:name.m3u8", async (req,res)=>{
  const name=slugify(req.params.name||""); const ch=channels.get(name); if(!ch) return res.status(404).send("Not found");
  const upstream = req.query.u ? String(req.query.u) : ch.src;
  try{
    const up=await fetchText(upstream);
    const out=up.text.split(/\r?\n/).map(line=>{
      if(line.startsWith("#EXT-X-KEY")){
        return line.replace(/URI="([^"]+)"/i,(_,u)=>`URI="${hostOf(req)}/seg/${name}?u=${encodeURIComponent(abs(up.base,u))}"`);
      }
      if(line.startsWith("#") || !line.trim()) return line;
      if(/\.(m3u8)(\?|#|$)/i.test(line.trim())){
        const child=abs(up.base,line.trim()); return `${hostOf(req)}/hls/${name}.m3u8?u=${encodeURIComponent(child)}`;
      }
      const seg=abs(up.base,line.trim()); return `${hostOf(req)}/seg/${name}?u=${encodeURIComponent(seg)}`;
    }).join("\n");
    res.setHeader("Content-Type","application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control","no-store");
    res.send(out);
  }catch(e){ res.status(502).type("text/plain").send("HLS error: "+(e?.message||e)); }
});

/* segmentos/keys */
app.get("/seg/:name", async (req,res)=>{
  const name=slugify(req.params.name||""); if(!channels.has(name)) return res.status(404).send("Not found");
  const u=String(req.query.u||""); if(!u) return res.status(400).send("Use ?u=");
  try{
    const r=await fetch(u,{redirect:"follow",headers:{"User-Agent":UA,"Referer":new URL(u).origin+"/","Origin":new URL(u).origin,"Accept":"*/*","Cache-Control":"no-cache"}});
    res.status(r.status); const ct=r.headers.get("content-type"); if(ct) res.setHeader("Content-Type",ct);
    res.setHeader("Cache-Control","no-store"); res.setHeader("Access-Control-Allow-Origin","*");
    const buf=Buffer.from(await r.arrayBuffer()); res.send(buf);
  }catch(e){ res.status(502).type("text/plain").send("Seg error: "+(e?.message||e)); }
});

app.listen(PORT,()=>console.log("HLS repeater up on",PORT));
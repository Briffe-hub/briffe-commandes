// Netlify Function: /api/cartels-lib
// Bibliothèque PARTAGÉE des étiquettes (cartels) par produit — corrections mémorisées,
// ré-appliquées automatiquement quand le produit réapparaît. Partagé par tous les postes.
// GET                 -> { lib: { "<productId>": { name, allergens:[{id,name}], at } , ... } }
// POST { id, entry }  -> enregistre/ met à jour UN produit (protégé par x-briffe-pass)
// POST { entries:{..}}-> enregistre plusieurs produits d'un coup (merge)
// Journal des impressions (réimpression sans rouvrir Sextan), clé Blob « history », 300 derniers tirages :
// GET ?history=1                                   -> { history:[ { id, at, ev:{id,name,date,client}, labels:[{id,name,allergens:[..]}], n } ] }
// POST { action:"history_add", job:{ ev, labels } } -> ajoute un tirage (sans mot de passe : imprimer n'en demande pas)
//                                                     un tirage identique dans les 30 min est fusionné (impression puis PDF)
// POST { action:"history_delete", id }              -> retire un tirage du journal (protégé par x-briffe-pass)

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN   = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE   = "briffe-cartels-lib";
const KEY     = "lib";

function cors(){ return { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"Content-Type, x-briffe-pass", "Access-Control-Allow-Methods":"GET, POST, OPTIONS", "Cache-Control":"no-store" }; }
const HKEY    = "history";
const HMAX    = 300;
function blobUrl(key){ return `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key||KEY)}`; }

async function blobGet(key){
  const r=await fetch(blobUrl(key), { headers:{ "Authorization":"Bearer "+TOKEN } });
  if(r.status===404) return null;
  if(!r.ok) throw new Error("Blob GET "+r.status);
  return r.json();
}
async function blobSet(v, key){
  const r=await fetch(blobUrl(key), { method:"PUT", headers:{ "Authorization":"Bearer "+TOKEN, "Content-Type":"application/json" }, body:JSON.stringify(v) });
  if(!r.ok) throw new Error("Blob PUT "+r.status);
}
const str=(v,n)=>String(v==null?"":v).slice(0,n);
function sanitizeJob(job){
  job=job||{};
  const ev=job.ev||{};
  const labels=(Array.isArray(job.labels)?job.labels:[]).slice(0,150).map(l=>({
    id: l&&l.id!=null ? str(l.id,40) : null,
    name: str(l&&l.name,200),
    allergens: (Array.isArray(l&&l.allergens)?l.allergens:[]).slice(0,20).map(a=>str((a&&a.name)||a,40)).filter(Boolean)
  })).filter(l=>l.name||l.allergens.length);
  return { ev:{ id:str(ev.id,40), name:str(ev.name,200), date:str(ev.date,40), client:str(ev.client,120) }, labels };
}
const jobSig=j=>JSON.stringify([j.ev.id, j.labels.map(l=>[l.id,l.name,l.allergens.join("|")])]);

function sanitizeEntry(e){
  e=e||{};
  const al=Array.isArray(e.allergens)?e.allergens.slice(0,20).map(a=>({ id:(a&&a.id)||null, name:String((a&&a.name)||a||"").slice(0,40) })).filter(a=>a.name):[];
  return { name:String(e.name||"").slice(0,200), allergens:al, at:Date.now() };
}
function checkPass(event){
  const required=process.env.BRIFFE_AUTH_PASSWORD;
  if(!required) return true;
  const given=(event.headers["x-briffe-pass"]||event.headers["X-Briffe-Pass"]||"").trim();
  return required.split(",").map(s=>s.trim()).filter(Boolean).indexOf(given)>=0;
}

exports.handler = async function(event){
  if(event.httpMethod==="OPTIONS") return { statusCode:200, headers:cors(), body:"" };
  if(!SITE_ID || !TOKEN) return { statusCode:500, headers:cors(), body:JSON.stringify({ error:"Stockage non configuré (SITE_ID / NETLIFY_TOKEN)." }) };
  try{
    if(event.httpMethod==="GET" && (event.queryStringParameters||{}).history){
      let h=null; try{ h=await blobGet(HKEY); }catch(e){ console.warn("history get:",e.message); }
      return { statusCode:200, headers:cors(), body:JSON.stringify({ history:Array.isArray(h)?h:[] }) };
    }
    if(event.httpMethod==="GET"){
      let lib=null; try{ lib=await blobGet(); }catch(e){ console.warn("blobGet:",e.message); }
      return { statusCode:200, headers:cors(), body:JSON.stringify({ lib:lib||{} }) };
    }
    if(event.httpMethod==="POST"){
      const body=JSON.parse(event.body||"{}");
      if(body.action==="history_add"){
        const job=sanitizeJob(body.job);
        if(!job.labels.length) return { statusCode:400, headers:cors(), body:JSON.stringify({ error:"Aucune étiquette." }) };
        let h=null; try{ h=await blobGet(HKEY); }catch(e){}
        h=Array.isArray(h)?h:[];
        const sig=jobSig(job), now=Date.now();
        const twin=h.find(x=>now-(x.at||0)<30*60*1000 && jobSig(x)===sig);
        if(twin){ twin.at=now; twin.n=(twin.n||1)+1; h=[twin].concat(h.filter(x=>x!==twin)); }
        else h.unshift(Object.assign({ id:now.toString(36)+Math.random().toString(36).slice(2,6), at:now, n:1 }, job));
        await blobSet(h.slice(0,HMAX), HKEY);
        return { statusCode:200, headers:cors(), body:JSON.stringify({ ok:true, merged:!!twin, count:h.length }) };
      }
      if(!checkPass(event)) return { statusCode:401, headers:cors(), body:JSON.stringify({ error:"Mot de passe invalide." }) };
      if(body.action==="history_delete"){
        let h=null; try{ h=await blobGet(HKEY); }catch(e){}
        h=(Array.isArray(h)?h:[]).filter(x=>x.id!==body.id);
        await blobSet(h, HKEY);
        return { statusCode:200, headers:cors(), body:JSON.stringify({ ok:true, count:h.length }) };
      }
      let cur=null; try{ cur=await blobGet(); }catch(e){}
      cur=(cur&&typeof cur==="object")?cur:{};
      if(body.id!=null){
        cur[String(body.id)]=sanitizeEntry(body.entry);
      } else if(body.entries && typeof body.entries==="object"){
        for(const k in body.entries) cur[String(k)]=sanitizeEntry(body.entries[k]);
      } else {
        return { statusCode:400, headers:cors(), body:JSON.stringify({ error:"id+entry ou entries requis" }) };
      }
      await blobSet(cur);
      return { statusCode:200, headers:cors(), body:JSON.stringify({ ok:true, count:Object.keys(cur).length }) };
    }
    return { statusCode:405, headers:cors(), body:"Method Not Allowed" };
  }catch(e){
    console.error("cartels-lib error:", e);
    return { statusCode:500, headers:cors(), body:JSON.stringify({ error:e.message }) };
  }
};

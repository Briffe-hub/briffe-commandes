// Netlify Function: /api/cartels-lib
// Bibliothèque PARTAGÉE des étiquettes (cartels) par produit — corrections mémorisées,
// ré-appliquées automatiquement quand le produit réapparaît. Partagé par tous les postes.
// GET                 -> { lib: { "<productId>": { name, allergens:[{id,name}], at } , ... } }
// POST { id, entry }  -> enregistre/ met à jour UN produit (protégé par x-briffe-pass)
// POST { entries:{..}}-> enregistre plusieurs produits d'un coup (merge)

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN   = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE   = "briffe-cartels-lib";
const KEY     = "lib";

function cors(){ return { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"Content-Type, x-briffe-pass", "Access-Control-Allow-Methods":"GET, POST, OPTIONS", "Cache-Control":"no-store" }; }
function blobUrl(){ return `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(KEY)}`; }

async function blobGet(){
  const r=await fetch(blobUrl(), { headers:{ "Authorization":"Bearer "+TOKEN } });
  if(r.status===404) return null;
  if(!r.ok) throw new Error("Blob GET "+r.status);
  return r.json();
}
async function blobSet(v){
  const r=await fetch(blobUrl(), { method:"PUT", headers:{ "Authorization":"Bearer "+TOKEN, "Content-Type":"application/json" }, body:JSON.stringify(v) });
  if(!r.ok) throw new Error("Blob PUT "+r.status);
}

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
    if(event.httpMethod==="GET"){
      let lib=null; try{ lib=await blobGet(); }catch(e){ console.warn("blobGet:",e.message); }
      return { statusCode:200, headers:cors(), body:JSON.stringify({ lib:lib||{} }) };
    }
    if(event.httpMethod==="POST"){
      if(!checkPass(event)) return { statusCode:401, headers:cors(), body:JSON.stringify({ error:"Mot de passe invalide." }) };
      const body=JSON.parse(event.body||"{}");
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

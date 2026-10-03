// Netlify Function: /api/cartels?id=NUM
// Produits finis d'une réception Sextan + leurs allergènes (pour imprimer les "cartels").
// GET ?id=NUM            -> { event:{...}, products:[{id,name,allergens:[{id,name}]}], meta:{endpoint} }
// GET ?id=NUM&debug=1    -> diagnostic de découverte de l'endpoint produit.
//
// Les allergènes sont une donnée CALCULÉE du produit (roll-up des sous-produits inclus),
// récupérée produit par produit via l'API Sextan. Plusieurs chemins candidats sont
// essayés : le premier qui renvoie des allergènes est mémorisé pour les suivants.

const BASE    = (process.env.SEXTAN_BASE || "https://briffe.sextan.catering").replace(/\/+$/, "");
const API_KEY = process.env.SEXTAN_API_KEY || "";
const AUTH    = { "X-API-Key": API_KEY };

function cors(){ return { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"Content-Type", "Cache-Control":"no-store" }; }

async function call(path, body, ms){
  const ctrl=new AbortController();
  const t=setTimeout(()=>ctrl.abort(), ms||8000);
  try{
    const r=await fetch(BASE+path,{ method:"POST", headers:Object.assign({ "Content-Type":"application/json","Accept":"application/json" },AUTH), body:JSON.stringify(body), signal:ctrl.signal });
    const txt=await r.text(); let json=null; try{ json=JSON.parse(txt); }catch(e){}
    return { status:r.status, json, len:txt.length };
  }catch(e){ return { status:0, json:null, len:0, err:e.name+": "+e.message }; }
  finally{ clearTimeout(t); }
}

function firstEvent(json){
  if(!json) return null;
  if(Array.isArray(json.data)) return json.data[0];
  if(json.data && json.data.id) return json.data;
  if(json.id) return json;
  return null;
}
function pickProduct(json, id){
  if(!json) return null;
  let p=null;
  if(Array.isArray(json.data)) p=json.data.find(x=>x && (x.id==id)) || json.data[0];
  else if(json.data && typeof json.data==="object") p=json.data;
  else if(json.id) p=json;
  return (p && typeof p==="object") ? p : null;
}
function hasAllergens(p){ return !!(p && Array.isArray(p.allergens)); }

// Chemins candidats pour récupérer un produit (le bon est découvert au 1er appel).
const CAND = [
  { path:"/api/products/details", body:id=>({ id }) },
  { path:"/api/products/search",  body:id=>({ id }) },
  { path:"/api/products/details", body:id=>({ ids:[id] }) },
  { path:"/api/products/get",     body:id=>({ id }) },
  { path:"/api/product/details",  body:id=>({ id }) }
];
let GOOD = null; // { path, body } mémorisé entre produits (et entre invocations chaudes)

async function discover(id){
  for(const c of CAND){
    const r=await call(c.path, c.body(id), 6000);
    if(r.status===200){
      const p=pickProduct(r.json, id);
      if(hasAllergens(p)){ GOOD=c; return { c, p }; }
    }
  }
  return null;
}
async function getProduct(id){
  if(GOOD){
    const r=await call(GOOD.path, GOOD.body(id), 6000);
    if(r.status===200){ const p=pickProduct(r.json, id); if(p) return p; }
  }
  const d=await discover(id);
  return d ? d.p : null;
}

// Normalisation des 14 allergènes réglementaires -> libellé minuscule propre.
function cleanAllergen(name){
  const n=String(name||"").toUpperCase();
  if(/GLUTEN|C[EÉ]R[EÉ]ALE|BL[EÉ]|FROMENT/.test(n)) return "gluten";
  if(/CRUSTAC/.test(n)) return "crustacés";
  if(/\bOEUF|ŒUF/.test(n)) return "œufs";
  if(/POISSON/.test(n)) return "poisson";
  if(/ARACHIDE|CACAHU/.test(n)) return "arachide";
  if(/SOJA/.test(n)) return "soja";
  if(/LAIT|LACT/.test(n)) return "lait";
  if(/FRUIT.?\s*A\s*COQUE|COQUE|NOIX|NOISETTE|AMANDE|CAJOU|PISTACHE/.test(n)) return "fruits à coque";
  if(/C[EÉ]LERI/.test(n)) return "céleri";
  if(/MOUTARDE/.test(n)) return "moutarde";
  if(/S[EÉ]SAME/.test(n)) return "sésame";
  if(/SULFITE|SULFUREUX|SO2/.test(n)) return "sulfites";
  if(/LUPIN/.test(n)) return "lupin";
  if(/MOLLUSQUE/.test(n)) return "mollusques";
  return String(name||"").toLowerCase();
}
function isFood(p){
  const bc=String(p && (p.billing_category||p.billingCategory) || "").toUpperCase();
  if(bc) return /NOURR|ALIMENT|FOOD|TRAITEUR/.test(bc) || !/LIVRAISON|TRANSPORT|SERVICE|PERSONNEL|MAT[EÉ]RIEL|LOCATION|FORFAIT|BOISSON/.test(bc);
  return true;
}
function looksLogistic(name){ return /livraison|d[eé]sinstall|installation|transport|forfait|location|reprise|mise en place|acompte|remise/i.test(String(name||"")); }

// Produits finis du menu (on écarte sous-produits auto et lignes logistiques évidentes).
function menuProducts(ev){
  const out=[]; const seen=new Set();
  const steps=(ev && ev.menu && ev.menu.steps)||[];
  steps.forEach(s=>{
    const st=s.step_type||s.name||s.title||"";
    (s.products||[]).forEach(p=>{
      if(!p || p.auto===true || p.sub_product===true) return;
      const id=p.id; if(id==null || seen.has(id)) return;
      if(looksLogistic(p.name)) return;
      seen.add(id);
      out.push({ id, name:p.name||"", step:st });
    });
  });
  return out;
}

async function pool(items, worker, concurrency){
  const res=new Array(items.length); let i=0;
  async function run(){ while(i<items.length){ const idx=i++; res[idx]=await worker(items[idx], idx); } }
  const runners=[]; for(let k=0;k<Math.min(concurrency,items.length);k++) runners.push(run());
  await Promise.all(runners); return res;
}

exports.handler = async function(event){
  if(event.httpMethod==="OPTIONS") return { statusCode:200, headers:cors(), body:"" };
  if(!API_KEY) return { statusCode:500, headers:cors(), body:JSON.stringify({ error:"SEXTAN_API_KEY non configurée." }) };
  const q=event.queryStringParameters||{};
  const id=q.id; const n=parseInt(id,10);
  if(!id || isNaN(n)) return { statusCode:400, headers:cors(), body:JSON.stringify({ error:"Paramètre id manquant" }) };

  // Récupère l'événement + menu.
  let ev=null;
  const rev=await call("/api/events/details", { id:n, include:["menu"] }, 9000);
  ev=firstEvent(rev.json);
  if(!ev) return { statusCode:502, headers:cors(), body:JSON.stringify({ error:"Réception introuvable ou service indisponible." }) };

  const prods=menuProducts(ev);

  if(q.debug==="1"){
    // Essaie chaque candidat sur le 1er produit et rapporte.
    const sample=prods[0];
    const probe=[];
    if(sample){
      for(const c of CAND){
        const r=await call(c.path, c.body(sample.id), 6000);
        const p=pickProduct(r.json, sample.id);
        probe.push({ path:c.path, body:Object.keys(c.body(sample.id)).join("+"), status:r.status, hasAllergens:hasAllergens(p), allergenKeys:p&&p.allergens?p.allergens.slice(0,6):null, pKeys:p?Object.keys(p).slice(0,25):null, err:r.err||null });
      }
    }
    return { statusCode:200, headers:cors(), body:JSON.stringify({ event:{ id:ev.id, name:ev.name, products:prods.length }, sampleProduct:sample||null, probe }, null, 2) };
  }

  // Récupère les allergènes produit par produit (endpoint découvert au vol).
  const enriched=await pool(prods, async (it)=>{
    try{
      const p=await getProduct(it.id);
      if(!p) return { id:it.id, name:it.name, step:it.step, allergens:[], found:false };
      if(!isFood(p)) return null; // ligne logistique détectée via la catégorie
      const seen=new Set(); const al=[];
      (Array.isArray(p.allergens)?p.allergens:[]).forEach(a=>{
        const lbl=cleanAllergen(a && (a.name||a.label||a));
        if(lbl && !seen.has(lbl)){ seen.add(lbl); al.push({ id:(a&&a.id)||null, name:lbl }); }
      });
      return { id:it.id, name:(p.name||it.name), step:it.step, description:p.description||"", allergens:al, found:true };
    }catch(e){ return { id:it.id, name:it.name, step:it.step, allergens:[], found:false }; }
  }, 6);

  const products=enriched.filter(Boolean);

  const out={
    event:{
      id:ev.id, name:ev.name||"", date:ev.date||"",
      pax:ev.nbr_pax||0,
      client:(ev.project&&ev.project.client&&ev.project.client.name)|| ev.location_name || ""
    },
    products,
    meta:{ endpoint:GOOD?GOOD.path:null, total:products.length }
  };
  return { statusCode:200, headers:cors(), body:JSON.stringify(out) };
};

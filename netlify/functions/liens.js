// Netlify Function: /api/liens
// Stocke la configuration des pages "menu de liens" (QR carte de visite) dans Netlify Blobs.
// Modèle MULTI-MENUS : config = { menus: [ { id, name, brand, cards }, ... ] }
//   GET                 → { config: {...} }            (objet complet — pour le back-office)
//   GET ?m=<id>         → { config: { brand, cards } } (UN menu — pour la page publique / QR)
//   POST { config }     → sauvegarde (protégé par en-tête x-briffe-pass = BRIFFE_AUTH_PASSWORD)

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN   = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE   = "briffe-liens";
const KEY     = "config";

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-briffe-pass",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store"
  };
}
function blobUrl() { return `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(KEY)}`; }

async function blobGet() {
  const r = await fetch(blobUrl(), { headers: { "Authorization": "Bearer " + TOKEN } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Blob GET " + r.status);
  return r.json();
}
async function blobSet(value) {
  const r = await fetch(blobUrl(), {
    method: "PUT",
    headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(value)
  });
  if (!r.ok) throw new Error("Blob PUT " + r.status);
}

function slugId(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || ("m" + Date.now().toString(36));
}

// Normalise tout vers { menus: [ {id,name,brand,cards} ] } (migre l'ancien format mono-menu {brand,cards})
function normalizeConfig(raw) {
  raw = raw || {};
  let menus;
  if (Array.isArray(raw.menus)) menus = raw.menus;
  else if (Array.isArray(raw.cards)) menus = [{ id: "default", name: "Menu général", brand: raw.brand || {}, cards: raw.cards }];
  else menus = [{ id: "default", name: "Menu général", brand: {}, cards: [] }];

  const seen = {};
  menus = menus.map((m, idx) => {
    m = m || {};
    let id = slugId(m.id || m.name || ("menu-" + (idx + 1)));
    while (seen[id]) id = id + "-2";
    seen[id] = 1;
    return {
      id,
      name: String(m.name || "Menu").slice(0, 60),
      brand: (m.brand && typeof m.brand === "object" && !Array.isArray(m.brand)) ? m.brand : {},
      cards: Array.isArray(m.cards) ? m.cards.slice(0, 200) : []
    };
  });
  if (!menus.length) menus = [{ id: "default", name: "Menu général", brand: {}, cards: [] }];
  return { menus };
}

function defaultConfig() {
  return {
    menus: [{
      id: "default",
      name: "Menu général",
      brand: { subtitle: "Traiteur événementiel éco-responsable", logo: "" },
      cards: [
        { id: "c1", title: "Commander des plateaux repas", subtitle: "Menu du mois, en ligne", url: "https://commander.briffe.me", icon: "🍱", size: "grande", enabled: true },
        { id: "c2", title: "Notre site", subtitle: "briffe.me", url: "https://briffe.me", icon: "🌐", size: "petite", enabled: true },
        { id: "c3", title: "Instagram", subtitle: "Suivez notre actualité", url: "", icon: "📸", size: "petite", enabled: true }
      ]
    }]
  };
}

// Renvoie UN menu (pour la page publique)
function pickMenu(cfg, id) {
  const menus = (cfg && Array.isArray(cfg.menus)) ? cfg.menus : [];
  if (!menus.length) return { brand: {}, cards: [] };
  const m = menus.find(x => x.id === id) || menus.find(x => x.id === "default") || menus[0];
  return { name: m.name || "", brand: m.brand || {}, cards: m.cards || [] };
}

function checkPass(event) {
  const required = process.env.BRIFFE_AUTH_PASSWORD;
  if (!required) return true;
  const given = (event.headers["x-briffe-pass"] || event.headers["X-Briffe-Pass"] || "").trim();
  const allowed = required.split(",").map(s => s.trim()).filter(Boolean);
  return allowed.indexOf(given) >= 0;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (!SITE_ID || !TOKEN) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "Stockage non configuré (SITE_ID / NETLIFY_TOKEN)." }) };

  try {
    if (event.httpMethod === "GET") {
      let raw = null;
      try { raw = await blobGet(); } catch (e) { console.warn("blobGet:", e.message); }
      const cfg = raw ? normalizeConfig(raw) : defaultConfig();
      const q = event.queryStringParameters || {};
      if (q.m != null && q.m !== "") {
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ config: pickMenu(cfg, String(q.m)) }) };
      }
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ config: cfg }) };
    }

    if (event.httpMethod === "POST") {
      if (!checkPass(event)) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Mot de passe invalide." }) };
      const body = JSON.parse(event.body || "{}");
      const cfg = body.config;
      if (!cfg || (!Array.isArray(cfg.menus) && !Array.isArray(cfg.cards))) {
        return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "config.menus (ou config.cards) requis" }) };
      }
      await blobSet(normalizeConfig(cfg));
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: cors(), body: "Method Not Allowed" };
  } catch (e) {
    console.error("liens error:", e);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};

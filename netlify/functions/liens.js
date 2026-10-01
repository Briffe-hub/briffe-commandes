// Netlify Function: /api/liens
// Stocke la configuration de la page "menu de liens" (QR carte de visite) dans Netlify Blobs.
// GET            → { config: {...} }  (public, lu par la page d'atterrissage)
// POST { config } → sauvegarde (protégé par en-tête x-briffe-pass = BRIFFE_AUTH_PASSWORD)

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

// Configuration par défaut (si rien n'est encore enregistré)
function defaultConfig() {
  return {
    brand: {
      subtitle: "Traiteur événementiel éco-responsable",
      logo: ""   // vide => la page affiche le logotype de marque embarqué par défaut
    },
    cards: [
      { id: "c1", title: "Plaquette commerciale", subtitle: "Découvrez nos prestations", url: "", icon: "📄", enabled: true },
      { id: "c2", title: "Commander des plateaux repas", subtitle: "En quelques clics", url: "https://commander.briffe.me", icon: "🍱", enabled: true },
      { id: "c3", title: "Site internet", subtitle: "briffe.me", url: "https://briffe.me", icon: "🌐", enabled: true },
      { id: "c4", title: "Instagram", subtitle: "Suivez notre actualité", url: "", icon: "📸", enabled: true },
      { id: "c5", title: "LinkedIn", subtitle: "Suivez-nous", url: "", icon: "💼", enabled: true }
    ]
  };
}

function checkPass(event) {
  const required = process.env.BRIFFE_AUTH_PASSWORD;
  if (!required) return true; // pas de mot de passe configuré -> écriture autorisée
  const given = (event.headers["x-briffe-pass"] || event.headers["X-Briffe-Pass"] || "").trim();
  const allowed = required.split(",").map(s => s.trim()).filter(Boolean);
  return allowed.indexOf(given) >= 0;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (!SITE_ID || !TOKEN) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "Stockage non configuré (SITE_ID / NETLIFY_TOKEN)." }) };

  try {
    if (event.httpMethod === "GET") {
      let cfg = null;
      try { cfg = await blobGet(); } catch (e) { console.warn("blobGet:", e.message); }
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ config: cfg || defaultConfig() }) };
    }

    if (event.httpMethod === "POST") {
      if (!checkPass(event)) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Mot de passe invalide." }) };
      const body = JSON.parse(event.body || "{}");
      const cfg = body.config;
      if (!cfg || !Array.isArray(cfg.cards)) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "config.cards requis" }) };
      await blobSet(cfg);
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers: cors(), body: "Method Not Allowed" };
  } catch (e) {
    console.error("liens error:", e);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};

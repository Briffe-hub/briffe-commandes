// Netlify Function: /api/prepa-defaults
// Défauts partagés (tous les postes) par onglet de la tuile "Préparation prestation".
// GET                 → { defaults: { <type>: { hid:{}, add:[], elO:{}, qtyO:{} }, ... } } (public)
// POST { defaults }   → sauvegarde l'intégralité (protégé par x-briffe-pass)
// POST { type, tab }  → met à jour les défauts d'UN seul onglet (merge), le reste inchangé.

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN   = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE   = "briffe-prepa-defaults";
const KEY     = "defaults";

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

function emptyTab() { return { hid: {}, add: [], elO: {}, qtyO: {} }; }
function sanitizeTab(t) {
  t = t || {};
  return {
    hid:  (t.hid  && typeof t.hid  === "object") ? t.hid  : {},
    elO:  (t.elO  && typeof t.elO  === "object") ? t.elO  : {},
    qtyO: (t.qtyO && typeof t.qtyO === "object") ? t.qtyO : {},
    add:  Array.isArray(t.add) ? t.add.slice(0, 200) : []
  };
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
      let d = null;
      try { d = await blobGet(); } catch (e) { console.warn("blobGet:", e.message); }
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ defaults: d || {} }) };
    }

    if (event.httpMethod === "POST") {
      if (!checkPass(event)) return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: "Mot de passe invalide." }) };
      const body = JSON.parse(event.body || "{}");

      // Remplacement d'un seul onglet (merge) : { type, tab }
      if (body.type) {
        let cur = null;
        try { cur = await blobGet(); } catch (e) { console.warn("blobGet:", e.message); }
        cur = (cur && typeof cur === "object") ? cur : {};
        cur[String(body.type)] = sanitizeTab(body.tab);
        await blobSet(cur);
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, defaults: cur }) };
      }

      // Remplacement global : { defaults }
      const defs = body.defaults;
      if (!defs || typeof defs !== "object") return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "defaults ou (type,tab) requis" }) };
      const clean = {};
      for (const k in defs) clean[k] = sanitizeTab(defs[k]);
      await blobSet(clean);
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, defaults: clean }) };
    }

    return { statusCode: 405, headers: cors(), body: "Method Not Allowed" };
  } catch (e) {
    console.error("prepa-defaults error:", e);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};

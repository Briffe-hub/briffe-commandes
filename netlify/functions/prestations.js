// Netlify Function: /api/prestations
// Stockage de la configuration des prestations (calculettes de préparation)
// via Netlify Blobs (API REST, sans dépendance npm). Même pattern que signatures.js.
// GET            → { config } (ou {} si vide)
// POST { config } → enregistre la configuration complète

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN   = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE   = "briffe-config";
const KEY     = "prestations";

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function blobUrl(key) {
  return `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`;
}

async function blobGet(key) {
  const r = await fetch(blobUrl(key), { headers: { "Authorization": "Bearer " + TOKEN } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Blob GET failed: " + r.status);
  return r.json();
}

async function blobSet(key, value) {
  const r = await fetch(blobUrl(key), {
    method: "PUT",
    headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(value)
  });
  if (!r.ok) throw new Error("Blob PUT failed: " + r.status);
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };

  if (!SITE_ID || !TOKEN) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "Stockage non configuré (SITE_ID / NETLIFY_TOKEN)." }) };
  }

  try {
    if (event.httpMethod === "GET") {
      const val = await blobGet(KEY);
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ config: val || null }) };
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      if (!body.config || typeof body.config !== "object") {
        return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "config requise" }) };
      }
      await blobSet(KEY, body.config);
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, savedAt: new Date().toISOString() }) };
    }

    return { statusCode: 405, headers: cors(), body: "Method Not Allowed" };
  } catch (e) {
    console.error("prestations error:", e);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};

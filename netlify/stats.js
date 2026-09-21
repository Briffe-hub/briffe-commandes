// Netlify Function: /api/stats
// Journal des prestations traitées (pour l'onglet Statistiques), stockage Netlify Blobs.
// Écrit par process.js à chaque traitement (clé = n° de commande, dédoublonné).
// GET            → { records: [ { dev, client, prestation, pax, date, lieu, ts }, ... ] }
// POST { records:[...] } → upsert en masse (utilisé pour l'import ponctuel depuis l'agenda)

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN   = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE   = "briffe-stats";

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
function keyFor(dev) {
  return String(dev || ("x_" + Date.now() + "_" + Math.random().toString(36).slice(2))).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}
function blobUrl(key) { return `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`; }

async function blobGet(key) {
  const r = await fetch(blobUrl(key), { headers: { "Authorization": "Bearer " + TOKEN } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Blob GET " + r.status);
  return r.json();
}
async function blobSet(key, value) {
  const r = await fetch(blobUrl(key), {
    method: "PUT",
    headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(value)
  });
  if (!r.ok) throw new Error("Blob PUT " + r.status);
}
async function blobList() {
  const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}`, { headers: { "Authorization": "Bearer " + TOKEN } });
  if (!r.ok) return [];
  const data = await r.json();
  return data.blobs || [];
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };
  if (!SITE_ID || !TOKEN) return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: "Stockage non configuré (SITE_ID / NETLIFY_TOKEN)." }) };

  try {
    if (event.httpMethod === "GET") {
      const blobs = await blobList();
      const records = [];
      for (let i = 0; i < blobs.length; i += 20) {
        const batch = blobs.slice(i, i + 20);
        const vals = await Promise.all(batch.map(b => blobGet(b.key).catch(() => null)));
        vals.forEach(v => { if (v) records.push(v); });
      }
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ records }) };
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const recs = Array.isArray(body.records) ? body.records : (body.record ? [body.record] : []);
      if (!recs.length) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: "records requis" }) };
      let count = 0;
      for (let i = 0; i < recs.length; i += 20) {
        const batch = recs.slice(i, i + 20);
        await Promise.all(batch.map(async r => {
          try { await blobSet(keyFor(r.dev), { dev: r.dev || "", client: r.client || "", prestation: r.prestation || "", pax: Number(r.pax) || 0, date: r.date || "", lieu: r.lieu || "", ts: r.ts || new Date().toISOString() }); count++; } catch (e) {}
        }));
      }
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, count }) };
    }

    return { statusCode: 405, headers: cors(), body: "Method Not Allowed" };
  } catch (e) {
    console.error("stats error:", e);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};

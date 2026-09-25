// Netlify Function: /api/addresses
// Utilise l'API REST Netlify Blobs (sans dépendance npm)
// GET  → liste toutes les adresses
// POST { action: "lookup", address } → cherche une adresse
// POST { action: "save", address, client, sheetName } → mémorise
// POST { action: "delete", address } → supprime

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN   = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE   = "briffe-addresses";
const LIEUX_STORE = "briffe-lieux";

function blobUrl(key) {
  return `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`;
}

// Helpers génériques (store paramétrable) pour le carnet de lieux
function urlS(store, key) { return `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}/${encodeURIComponent(key)}`; }
async function getS(store, key) {
  const r = await fetch(urlS(store, key), { headers: { "Authorization": "Bearer " + TOKEN } });
  if (r.status === 404) return null; if (!r.ok) throw new Error("Blob GET " + r.status); return r.json();
}
async function setS(store, key, value) {
  const r = await fetch(urlS(store, key), { method: "PUT", headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(value) });
  if (!r.ok) throw new Error("Blob PUT " + r.status);
}
async function delS(store, key) { await fetch(urlS(store, key), { method: "DELETE", headers: { "Authorization": "Bearer " + TOKEN } }); }
async function listS(store) {
  const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${store}`, { headers: { "Authorization": "Bearer " + TOKEN } });
  if (!r.ok) return []; const data = await r.json(); return data.blobs || [];
}
function lieuKey(id) { return String(id || ("L_" + Date.now() + "_" + Math.random().toString(36).slice(2))).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120); }

function normalizeAddress(addr) {
  return (addr || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .substring(0, 200);
}

async function blobGet(key) {
  const r = await fetch(blobUrl(key), {
    headers: { "Authorization": "Bearer " + TOKEN }
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Blob GET failed: " + r.status);
  return r.json();
}

async function blobSet(key, value) {
  const r = await fetch(blobUrl(key), {
    method: "PUT",
    headers: {
      "Authorization": "Bearer " + TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(value)
  });
  if (!r.ok) throw new Error("Blob PUT failed: " + r.status);
}

async function blobDelete(key) {
  await fetch(blobUrl(key), {
    method: "DELETE",
    headers: { "Authorization": "Bearer " + TOKEN }
  });
}

async function blobList() {
  const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}`, {
    headers: { "Authorization": "Bearer " + TOKEN }
  });
  if (!r.ok) return [];
  const data = await r.json();
  return data.blobs || [];
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors(), body: "" };

  try {
    if (event.httpMethod === "GET") {
      const blobs = await blobList();
      console.log("blobList result:", JSON.stringify(blobs).substring(0, 300));
      const result = {};
      for (const b of blobs) {
        try {
          const val = await blobGet(b.key);
          console.log("blobGet", b.key, "->", JSON.stringify(val).substring(0, 100));
          result[b.key] = val;
        } catch(e) { console.error("blobGet error:", b.key, e.message); }
      }
      console.log("Returning", Object.keys(result).length, "addresses");
      return { statusCode: 200, headers: cors(), body: JSON.stringify(result) };
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body);

      if (body.action === "lookup") {
        const key = normalizeAddress(body.address);
        const val = await blobGet(key);
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ found: !!val, data: val, key }) };
      }

      if (body.action === "save") {
        const key = normalizeAddress(body.address);
        await blobSet(key, {
          address: body.address,
          client: body.client,
          sheetName: body.sheetName,
          savedAt: new Date().toISOString()
        });
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, key }) };
      }

      if (body.action === "delete") {
        const key = normalizeAddress(body.address);
        await blobDelete(key);
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
      }

      // ===== Carnet de lieux structuré (nom du lieu / bâtiment / adresse / salle) =====
      if (body.action === "lieux-list") {
        const blobs = await listS(LIEUX_STORE);
        const records = [];
        for (let i = 0; i < blobs.length; i += 20) {
          const batch = blobs.slice(i, i + 20);
          const vals = await Promise.all(batch.map(b => getS(LIEUX_STORE, b.key).catch(() => null)));
          vals.forEach(v => { if (v) records.push(v); });
        }
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ records }) };
      }

      if (body.action === "lieux-save") {
        const rec = body.record || {};
        const id = lieuKey(rec.id);
        const value = {
          id,
          nomLieu:  rec.nomLieu  || "",
          batiment: rec.batiment || "",
          adresse:  rec.adresse  || "",
          salle:    rec.salle    || "",
          savedAt:  new Date().toISOString()
        };
        await setS(LIEUX_STORE, id, value);
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, id, record: value }) };
      }

      if (body.action === "lieux-delete") {
        await delS(LIEUX_STORE, lieuKey(body.id));
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true }) };
      }
    }

    return { statusCode: 405, body: "Method Not Allowed" };
  } catch(e) {
    console.error("addresses error:", e);
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

// Netlify Function: /api/addresses
// Utilise l'API REST Netlify Blobs (sans dépendance npm)
// GET  → liste toutes les adresses
// POST { action: "lookup", address } → cherche une adresse
// POST { action: "save", address, client, sheetName } → mémorise
// POST { action: "delete", address } → supprime

const SITE_ID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
const TOKEN   = process.env.NETLIFY_TOKEN || process.env.NETLIFY_API_KEY;
const STORE   = "briffe-addresses";

function blobUrl(key) {
  return `https://api.netlify.com/api/v1/blobs/${SITE_ID}/${STORE}/${encodeURIComponent(key)}`;
}

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

// Netlify Function: /api/addresses
// GET  → retourne toute la base adresses
// POST → { action: "lookup", address } → cherche une adresse
// POST → { action: "save", address, client, sheetName } → mémorise une adresse

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "briffe-addresses";

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors(), body: "" };
  }

  const store = getStore(STORE_NAME);

  try {
    if (event.httpMethod === "GET") {
      // List all addresses
      const { blobs } = await store.list();
      const result = {};
      for (const blob of blobs) {
        const val = await store.get(blob.key, { type: "json" });
        result[blob.key] = val;
      }
      return {
        statusCode: 200,
        headers: cors(),
        body: JSON.stringify(result)
      };
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body);

      if (body.action === "lookup") {
        const key = normalizeAddress(body.address);
        const val = await store.get(key, { type: "json" }).catch(() => null);
        return {
          statusCode: 200,
          headers: cors(),
          body: JSON.stringify({ found: !!val, data: val, key })
        };
      }

      if (body.action === "save") {
        const key = normalizeAddress(body.address);
        await store.setJSON(key, {
          address: body.address,
          client: body.client,
          sheetName: body.sheetName,
          savedAt: new Date().toISOString()
        });
        return {
          statusCode: 200,
          headers: cors(),
          body: JSON.stringify({ ok: true, key })
        };
      }

      if (body.action === "delete") {
        const key = normalizeAddress(body.address);
        await store.delete(key);
        return {
          statusCode: 200,
          headers: cors(),
          body: JSON.stringify({ ok: true })
        };
      }
    }

    return { statusCode: 405, body: "Method Not Allowed" };

  } catch(e) {
    console.error("addresses error:", e);
    return {
      statusCode: 500,
      headers: cors(),
      body: JSON.stringify({ error: e.message })
    };
  }
};

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

function cors() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

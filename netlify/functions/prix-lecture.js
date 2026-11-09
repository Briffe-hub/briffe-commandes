// Netlify Function : /.netlify/functions/prix-lecture  (module Prix fournisseurs)
// Lit UNE page de BL / facture fournisseur et renvoie son contenu structuré.
// POST JSON (en-tête x-briffe-pass) :
//   { image: "data:image/jpeg;base64,..." }   photo ou page de PDF scanné
//   { text: "..." }                           texte extrait d'un PDF natif (dans le navigateur)
//   + { page: 1, pages: 3 } facultatif (contexte)
// Réponse : { ok, data:{ fournisseur, document, lignes:[...] }, ms, model }
// Une page par appel : les pages d'un même document sont lues en parallèle par la page web,
// ce qui garde chaque appel court (limite de durée des fonctions Netlify).

const U = require("../lib/briffe-users.js"); // comptes et rôles (lecteur < editeur < admin)
const MODEL = process.env.PRIX_MODEL || "claude-sonnet-5-5";
const API_KEY = process.env.ANTHROPIC_API_KEY || "";

function headers() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-briffe-pass, x-briffe-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store"
  };
}
const json = (code, obj) => ({ statusCode: code, headers: headers(), body: JSON.stringify(obj) });


const SYSTEM = `Tu lis des bons de livraison et des factures de fournisseurs alimentaires pour un traiteur (BRIFFE / FESTOYER). Tu renvoies UNIQUEMENT un objet JSON valide, sans texte autour, sans bloc de code.

Format :
{
 "fournisseur": { "nom": string|null, "siret": string|null, "tva": string|null },
 "document": { "type": "facture"|"bl"|"autre", "numero": string|null, "date": "AAAA-MM-JJ"|null, "bl": [string] },
 "lignes": [
  {
   "ref": string|null,            // code ARTICLE du fournisseur (colonne CODE / CODE ART. / RÉF.), identique à chaque livraison, sans espaces
   "lot": string|null,            // numéro de LOT / traçabilité de la ligne s'il est imprimé (change à chaque livraison) ; jamais dans "ref"
   "designation": string,         // libellé tel qu'imprimé
   "quantite": number|null,       // quantité facturée
   "unite_quantite": string|null, // KG, L, UN, PCE, CAR, COLIS...
   "prix": number|null,           // prix unitaire HT facturé (après remise ligne si indiquée)
   "unite_prix": string|null,     // unité à laquelle s'applique le prix : KG, L, UN, PCE, CAR...
   "base_prix": { "quantite": number, "unite": "g"|"ml"|"piece" } | null,
   "montant": number|null,        // montant HT de la ligne
   "bl": string|null              // numéro du BL auquel la ligne appartient, si le document en regroupe plusieurs
  }
 ],
 "remarques": [string]
}

Règles :
- Le vendeur (fournisseur) est l'émetteur du document, jamais le client. Le client est BRIFFE / FESTOYER : ne le mets jamais comme fournisseur.
- Une ligne = un article facturé. Ignore les lignes de lot, DLC, code-barre, sous-totaux, frais de port sans article, textes de livraison.
- "ref" est le CODE ARTICLE, qui désigne le produit et reste le même d'une facture à l'autre. Ne mets JAMAIS dans "ref" :
  un numéro de lot (LOT, N° LOT, LOT N°, TRAÇABILITÉ, N° ABATTAGE, N° D'ÉLEVAGE, ESTAMPILLE), une DLC/DDM/date de fabrication,
  un poids, un numéro de colis ou de palette, un numéro de pesée. Un numéro de lot va dans "lot".
  Indices d'un lot : colonne intitulée « Lot », valeur différente pour un même produit, valeur qui contient une date,
  ou numéro imprimé sous la désignation. S'il n'y a pas de colonne de code article distincte, mets "ref": null
  plutôt que d'y recopier un lot. En cas de doute entre code article et lot, mets "ref": null et ajoute une remarque.
- Nombres au format JSON (point décimal), sans symbole €. « 16,80 » -> 16.8.
- "base_prix" décrit ce que représente UNE unité de prix, en grammes, millilitres ou pièces, d'après la désignation et l'unité de prix :
  * prix au KG -> {"quantite":1000,"unite":"g"} ; prix au L -> {"quantite":1000,"unite":"ml"}
  * « NAVETTES NATURE 15G X100 » à 16,80 / UN (le colis) -> {"quantite":100,"unite":"piece"}
  * « CREME UHT 18% 6X1L » à 2,78 / UN, 12 UN facturées pour 2 colis -> l'unité est la bouteille de 1 L -> {"quantite":1000,"unite":"ml"}
  * « SEL FIN SACHET 1KG » à 0,62 / UN -> {"quantite":1000,"unite":"g"}
  * « MINI WRAPS X 48 » à 24,86 / UN, 5 UN pour 5 colis -> {"quantite":48,"unite":"piece"}
  * « LAIT COCO 1L », 6 L à 5,784 -> prix au litre -> {"quantite":1000,"unite":"ml"}
  Utilise la cohérence quantité × prix = montant et le nombre de colis pour déterminer l'unité réelle. Si tu ne peux pas déterminer, mets null.
- Ne devine jamais une référence ou un prix illisible : mets null et ajoute une remarque.
- "document.bl" liste les numéros de BL repris sur le document.`;

function extractJson(text) {
  const s = String(text || "").trim();
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  return null;
}

function cleanNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return isFinite(n) ? n : null;
}

// Code article : jamais identique au lot, jamais une date (garde-fou si la lecture se trompe)
function cleanRef(l) {
  if (!l || !l.ref) return null;
  const ref = String(l.ref).replace(/\s+/g, "");
  const lot = l.lot ? String(l.lot).replace(/\s+/g, "") : "";
  if (lot && ref.toLowerCase() === lot.toLowerCase()) return null;
  if (/^(lot|l)[-:.#]?\d/i.test(ref)) return null;                                      // « LOT1234 », « L-2611… »
  if (/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(ref) || /^\d{4}-\d{2}-\d{2}$/.test(ref)) return null; // une date
  return ref;
}

function normalize(d) {
  d = d && typeof d === "object" ? d : {};
  const f = d.fournisseur || {}, doc = d.document || {};
  const lignes = (Array.isArray(d.lignes) ? d.lignes : []).map(l => {
    const bp = l && l.base_prix && cleanNumber(l.base_prix.quantite) && ["g", "ml", "piece"].includes(l.base_prix.unite)
      ? { quantite: cleanNumber(l.base_prix.quantite), unite: l.base_prix.unite } : null;
    return {
      ref: cleanRef(l),
      lot: l && l.lot ? String(l.lot).trim().slice(0, 60) : null,
      designation: String((l && l.designation) || "").trim(),
      quantite: cleanNumber(l && l.quantite),
      unite_quantite: l && l.unite_quantite ? String(l.unite_quantite).toUpperCase() : null,
      prix: cleanNumber(l && l.prix),
      unite_prix: l && l.unite_prix ? String(l.unite_prix).toUpperCase() : null,
      base_prix: bp,
      montant: cleanNumber(l && l.montant),
      bl: l && l.bl ? String(l.bl) : null
    };
  }).filter(l => l.designation || l.ref);
  return {
    fournisseur: { nom: f.nom || null, siret: f.siret || null, tva: f.tva || null },
    document: {
      type: ["facture", "bl", "autre"].includes(doc.type) ? doc.type : "autre",
      numero: doc.numero ? String(doc.numero) : null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(doc.date || "") ? doc.date : null,
      bl: Array.isArray(doc.bl) ? doc.bl.map(String) : []
    },
    lignes,
    remarques: Array.isArray(d.remarques) ? d.remarques.map(String).slice(0, 20) : []
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: headers(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée" });
  { const deny = await U.guard(event, U.roleFor(event, {}, "editeur"), json, "prix"); if (deny) return deny; }
  if (!API_KEY) return json(500, { error: "ANTHROPIC_API_KEY non configurée." });

  let body = {}; try { body = JSON.parse(event.body || "{}"); } catch (e) {}
  const ctx = body.pages > 1 ? `Page ${body.page || "?"} sur ${body.pages} d'un même document. ` : "";
  const content = [];
  if (body.image) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(body.image));
    if (!m) return json(400, { error: "Image invalide (data URL JPEG/PNG/WebP attendue)." });
    content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
    content.push({ type: "text", text: ctx + "Lis ce document et renvoie le JSON demandé." });
  } else if (body.text && String(body.text).trim().length > 20) {
    content.push({ type: "text", text: ctx + "Texte extrait d'un PDF (mise en page approximative) :\n\n" + String(body.text).slice(0, 60000) + "\n\nRenvoie le JSON demandé." });
  } else {
    return json(400, { error: "Rien à lire : image ou texte attendu." });
  }

  const started = Date.now();
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 6000, system: SYSTEM, messages: [{ role: "user", content }] })
    });
    const j = await r.json();
    if (!r.ok) return json(502, { error: "Lecture refusée par l'API Claude (" + r.status + ") : " + ((j.error && j.error.message) || "erreur inconnue"), model: MODEL });
    const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const parsed = extractJson(text);
    if (!parsed) return json(502, { error: "Réponse illisible (JSON attendu).", raw: text.slice(0, 500), model: MODEL });
    return json(200, { ok: true, data: normalize(parsed), ms: Date.now() - started, model: MODEL, truncated: j.stop_reason === "max_tokens" });
  } catch (e) {
    return json(500, { error: e.message, ms: Date.now() - started });
  }
};

exports._normalize = normalize; // pour les tests

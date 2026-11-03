// Module Prix fournisseurs : reconnaître qu'une ligne de facture et une ligne fournisseur d'une fiche
// Sextan désignent le MÊME produit chez le MÊME fournisseur.
// Certains fournisseurs (ex. NOMIE) n'ont pas de code article : la « référence » saisie dans Sextan est
// alors le libellé du produit (« Cannelle verum de Ceylan »), et la facture peut porter ce libellé en
// désignation, avec ou sans code. Comparer seulement les codes créait des références en double.

// Codes : insensibles à la casse et aux zéros de tête (« 0307637 » = « 307637 »).
const sameRef = (a, b) => !!a && !!b && String(a).trim().replace(/^0+/, "").toLowerCase() === String(b).trim().replace(/^0+/, "").toLowerCase();
// Libellés : insensibles aux accents, à la casse, à la ponctuation et aux espaces.
const normTxt = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sameTxt = (a, b) => { const x = normTxt(a), y = normTxt(b); return !!x && x.length >= 3 && x === y; };

// La ligne fournisseur `s` (fiche Sextan) correspond-elle à la ligne de facture { ref, designation } ?
// Renvoie la raison ("ref", "libelle") ou null.
function lineMatch(s, ref, designation) {
  if (!s) return null;
  if (sameRef(s.ref, ref)) return "ref";
  // référence Sextan = libellé du produit, facture sans code ou avec un code différent
  if (sameTxt(s.ref, designation) || sameTxt(s.ref, ref)) return "libelle";
  // libellé fournisseur renseigné dans Sextan
  if (sameTxt(s.supplier_label, designation) || sameTxt(s.supplier_label, ref)) return "libelle";
  return null;
}

// Ligne fournisseur existante, chez ce fournisseur, pour ce produit (null si aucune).
function findSupplierLine(lines, providerId, ref, designation) {
  const mine = (lines || []).filter(s => Number(s.provider_id) === Number(providerId));
  return mine.find(s => lineMatch(s, ref, designation) === "ref") || mine.find(s => lineMatch(s, ref, designation)) || null;
}

// Lignes en double déjà présentes sur une fiche (même fournisseur, même référence ou même libellé).
function duplicateLines(lines) {
  const seen = {}, dups = [];
  (lines || []).forEach(s => {
    const k = s.provider_id + "|" + (normTxt(s.ref) || ("label:" + normTxt(s.supplier_label)));
    if (!normTxt(s.ref) && !normTxt(s.supplier_label)) return;
    if (seen[k]) dups.push(s); else seen[k] = s;
  });
  return dups;
}

module.exports = { sameRef, normTxt, sameTxt, lineMatch, findSupplierLine, duplicateLines };

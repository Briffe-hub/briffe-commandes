// Messages clairs pour les erreurs de l'API Anthropic (Claude), affichés tels quels dans les briques.
const CONSOLE = "platform.claude.com";
function frAnthropicError(status, err) {
  const msg = String((err && err.message) || "");
  const type = String((err && err.type) || "");
  if (/credit balance is too low|billing|purchase credits/i.test(msg))
    return "Crédit API Claude épuisé : les lectures automatiques sont suspendues. Un administrateur doit recharger les crédits (ou récupérer les crédits du forfait Max) sur " + CONSOLE + ", rubrique Billing, puis relancer le traitement.";
  if (type === "authentication_error" || status === 401)
    return "Clé API Claude refusée (invalide ou supprimée) : vérifier la variable ANTHROPIC_API_KEY sur Netlify.";
  if (type === "permission_error" || status === 403)
    return "Clé API Claude sans autorisation pour cette demande (" + msg + ").";
  if (type === "rate_limit_error" || status === 429)
    return "Trop de lectures en même temps (limite de l'API Claude) : patiente une minute et relance.";
  if (type === "overloaded_error" || status === 529)
    return "Service Claude momentanément surchargé : relance dans quelques minutes.";
  return "";
}
module.exports = { frAnthropicError };

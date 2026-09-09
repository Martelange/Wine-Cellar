// ============================================================
//  PARSING DES COMMANDES — module isole pour etre testable
//  Extrait de bot_multi.js sans aucune modification de logique.
//  Voir test/parsing.test.js pour les cas verrouilles.
// ============================================================

// Mots parasites retires avant le parsing (politesse, liaisons)
const MOTS_IGNORES = /\b(stp|svp|aub|merci|please|et|en|s'il|vous|plait|si)\b/gi;

// Transforme un message libre en liste [{ lettre, qte }] ou null si rien trouve.
// - accepte "3A", "3 A", "a3", "A 3", commandes collees "12a2b4c2d", milieu de phrase
// - une seule occurrence par lettre est retenue (la premiere)
// - quantite acceptee : 1 a 200
function parseCommandeMulti(msgBody) {
  const txt = msgBody.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(MOTS_IGNORES, ' ').replace(/[,;\/]/g, ' ').replace(/\s+/g, ' ').trim();
  const resultats = [];
  const pattern = /(\d+)\s*([a-z])(?![a-z])|(?<![a-z])([a-z])\s*(\d+)/gi;
  let match;
  while ((match = pattern.exec(txt)) !== null) {
    let qte, lettre;
    if (match[1] && match[2]) { qte = parseInt(match[1]); lettre = match[2].toUpperCase(); }
    else if (match[3] && match[4]) { qte = parseInt(match[4]); lettre = match[3].toUpperCase(); }
    if (qte && lettre && qte > 0 && qte <= 200)
      if (!resultats.find(r => r.lettre === lettre)) resultats.push({ lettre, qte });
  }
  return resultats.length > 0 ? resultats : null;
}

module.exports = { parseCommandeMulti, MOTS_IGNORES };

// ============================================================
//  MESSAGES PERSONNALISABLES (page Reglages du dashboard)
//  Textes par defaut + remplissage des variables {xxx}.
//  Fonctions pures, testables (test/messages.test.js).
// ============================================================

// Message final envoye dans le groupe ~20 s apres le sticker Sold Out.
// Variables : {duree} {bouteilles} {commandes}
const MESSAGE_FIN_DEFAUT =
  '🔥 *SOLD OUT en {duree}* ⚡\n\n' +
  '*Un enorme merci a tous* 🙏\nVous avez ete ultra rapides !\n\n' +
  '📦 *{bouteilles} bouteilles* vendues\n' +
  '👥 *{commandes} commandes* enregistrees\n\n' +
  'Vous serez contactes prochainement. 🍷';

// Message prive envoye a un client absent d'Odoo, a la creation des Sales Orders.
// Variables : {nom}
const MESSAGE_NOUVEAU_CLIENT_DEFAUT =
  'Bonjour,\n\nMerci beaucoup pour cette première commande sur Wine Cellar ! 🍷\n\n' +
  'Puis-je vous demander votre adresse mail ?\n' +
  'Avez-vous besoin d\'une facture ? Si oui, je veux bien les coordonnées.\n\n' +
  'Merci d\'avance\nBon week-end\n\nHugues / Wine Cellar';

const LONGUEUR_MAX = 4000;

function reglagesParDefaut() {
  return { messageFin: MESSAGE_FIN_DEFAUT, messageNouveauClient: MESSAGE_NOUVEAU_CLIENT_DEFAUT };
}

// Fusionne des reglages lus (fichier ou requete) avec les valeurs par defaut.
// Un champ absent ou non texte reprend le defaut ; une chaine vide est gardee
// (= l'operateur ne veut pas de ce message).
function normaliserReglages(brut) {
  const r = reglagesParDefaut();
  if (brut && typeof brut === 'object') {
    for (const cle of Object.keys(r)) {
      if (typeof brut[cle] === 'string') r[cle] = brut[cle].slice(0, LONGUEUR_MAX);
    }
  }
  return r;
}

// Remplace {variable} par sa valeur ; une variable inconnue est laissee telle quelle.
function remplirModele(modele, variables) {
  return String(modele || '').replace(/\{(\w+)\}/g, (tout, nom) =>
    Object.prototype.hasOwnProperty.call(variables, nom) ? String(variables[nom]) : tout);
}

module.exports = {
  MESSAGE_FIN_DEFAUT, MESSAGE_NOUVEAU_CLIENT_DEFAUT,
  reglagesParDefaut, normaliserReglages, remplirModele
};

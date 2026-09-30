// ============================================================
//  LECTURE DES MESSAGES BAILEYS — fonctions pures, testables
//  (test/whatsapp-msg.test.js). Aucun acces reseau ni etat global.
// ============================================================

// Retire le domaine et le suffixe d'appareil : '32477...:12@s.whatsapp.net' -> '32477...'
function numeroDepuisJid(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function estJidTelephone(jid) { return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net'); }
function estJidLid(jid) { return typeof jid === 'string' && jid.endsWith('@lid'); }

// Numero de telephone de l'auteur d'un message.
// Baileys 7 : dans un groupe, key.participant est souvent un identifiant anonyme
// (xxx@lid) et le vrai numero est dans key.participantAlt. On prefere toujours
// un JID telephone ; sinon on consulte la table lid -> numero connue ;
// en dernier recours on garde l'identifiant anonyme (mieux que rien).
function numeroAuteur(key, lidVersNumero = {}) {
  const k = key || {};
  const candidats = [k.participantAlt, k.participant, k.remoteJidAlt, k.remoteJid];
  const tel = candidats.find(estJidTelephone);
  if (tel) return numeroDepuisJid(tel);
  const lid = numeroDepuisJid(k.participant || k.remoteJid);
  return lidVersNumero[lid] || lid;
}

// Paire { lid, numero } apprise d'un message (les deux formes presentes), ou null
function correspondanceLid(key) {
  const k = key || {};
  const paires = [[k.participant, k.participantAlt], [k.remoteJid, k.remoteJidAlt]];
  for (const [a, b] of paires) {
    if (estJidLid(a) && estJidTelephone(b)) return { lid: numeroDepuisJid(a), numero: numeroDepuisJid(b) };
    if (estJidTelephone(a) && estJidLid(b)) return { lid: numeroDepuisJid(b), numero: numeroDepuisJid(a) };
  }
  return null;
}

function texteDe(m) {
  return (m && (m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.buttonsResponseMessage?.selectedDisplayText
    || m.listResponseMessage?.title)) || '';
}

// Edition d'un message (protocolMessage type 14 = MESSAGE_EDIT).
// WhatsApp l'envoie aujourd'hui enveloppee : message.editedMessage.message.protocolMessage.
// L'ancienne forme (protocolMessage a la racine) reste acceptee.
// Retourne { idOriginal, nouveauTexte } ou null.
function extraireEdition(msg) {
  const m = msg?.message || {};
  const proto = m.protocolMessage || m.editedMessage?.message?.protocolMessage;
  if (!proto || proto.type !== 14) return null;
  let contenu = proto.editedMessage || {};
  if (contenu.editedMessage?.message) contenu = contenu.editedMessage.message;
  return { idOriginal: proto.key?.id || '', nouveauTexte: texteDe(contenu) };
}

// Message cite (reponse a un message) : { idCite, auteurCite } ou null
function extraireCitation(msg) {
  const m = msg?.message || {};
  const ctx = m.extendedTextMessage?.contextInfo
    || m.imageMessage?.contextInfo
    || m.videoMessage?.contextInfo;
  if (!ctx || !ctx.stanzaId) return null;
  return { idCite: ctx.stanzaId, auteurCite: ctx.participant || '' };
}

module.exports = {
  numeroDepuisJid, numeroAuteur, correspondanceLid,
  texteDe, extraireEdition, extraireCitation
};

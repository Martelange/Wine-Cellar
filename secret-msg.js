// ============================================================
//  DECHIFFREMENT DES MESSAGES "SECRETS" (secretEncryptedMessage)
//  WhatsApp chiffre les editions de message en groupe avec la cle
//  propre au message d'origine (messageContextInfo.messageSecret).
//  Schema identique a decryptPollVote / decryptEventResponse de Baileys
//  (lib/Utils/process-message.js) : HMAC-SHA256 en deux temps puis AES-256-GCM.
//  Le GCM authentifie : une mauvaise cle ou un mauvais parametre ECHOUE,
//  il ne produit jamais un texte faux. Teste par test/secret-msg.test.js.
// ============================================================

const crypto = require('crypto');

// Libelles "usage" candidats pour une edition de message (le libelle exact
// n'est pas documente ; le GCM dit lequel est le bon).
const USAGES_EDITION = ['Message Edit', 'Enc Message Edit', 'Edit Message', 'Message Edit Secret', 'Event Edit'];

function cleDeChiffrement(secret, msgId, auteurJid, modificateurJid, usage) {
  const sign = Buffer.concat([
    Buffer.from(msgId), Buffer.from(auteurJid), Buffer.from(modificateurJid),
    Buffer.from(usage), Buffer.from([1])
  ]);
  const key0 = crypto.createHmac('sha256', Buffer.alloc(32)).update(Buffer.from(secret)).digest();
  return crypto.createHmac('sha256', key0).update(sign).digest();
}

function dechiffrerGCM(payload, cle, iv, aad) {
  const buf = Buffer.from(payload);
  const decipher = crypto.createDecipheriv('aes-256-gcm', cle, Buffer.from(iv));
  decipher.setAAD(aad);
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]);
}

// Inverse exact, pour les tests uniquement
function chiffrerGCM(clair, cle, iv, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', cle, iv);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(clair), cipher.final(), cipher.getAuthTag()]);
}

// Retire le suffixe d'appareil : '32477...:12@s.whatsapp.net' -> '32477...@s.whatsapp.net'
function jidSansAppareil(jid) {
  const [user, serveur] = String(jid || '').split('@');
  return serveur ? user.split(':')[0] + '@' + serveur : '';
}

function uniques(liste) {
  return [...new Set(liste.map(jidSansAppareil).filter(Boolean))];
}

// Essaie toutes les combinaisons (auteur x modificateur x usage) jusqu'a ce que
// le GCM valide. Retourne { octets, variante } ou null si aucune ne marche.
function dechiffrerSecretMessage({ encPayload, encIv }, { secret, msgId, auteurs, modificateurs, usages = USAGES_EDITION }) {
  if (!encPayload || !encIv || !secret || !msgId) return null;
  for (const usage of usages) {
    for (const auteur of uniques(auteurs || [])) {
      for (const modif of uniques(modificateurs || [])) {
        try {
          const cle = cleDeChiffrement(secret, msgId, auteur, modif, usage);
          const octets = dechiffrerGCM(encPayload, cle, encIv, Buffer.from(msgId + '\u0000' + modif));
          return { octets, variante: usage + ' / auteur ' + auteur.split('@')[1] + ' / modif ' + modif.split('@')[1] };
        } catch (e) { /* mauvaise combinaison : le GCM refuse, on essaie la suivante */ }
      }
    }
  }
  return null;
}

module.exports = { USAGES_EDITION, cleDeChiffrement, dechiffrerGCM, chiffrerGCM, dechiffrerSecretMessage, jidSansAppareil };

// ============================================================
//  DECHIFFREMENT DES MESSAGES "SECRETS" (secretEncryptedMessage)
//  WhatsApp chiffre les editions de message en groupe avec la cle
//  propre au message d'origine (messageContextInfo.messageSecret).
//  Derivation identique a decryptPollVote / decryptEventResponse de Baileys
//  (lib/Utils/process-message.js) : HMAC-SHA256 en deux temps (= HKDF) puis
//  AES-256-GCM. Reference : whatsmeow msgsecret.go (generateMsgSecretKey) :
//  usage "Message Edit", donnees authentifiees (AAD) VIDES sauf pour
//  "Poll Vote" / "Event Response" (AAD = id + \0 + modificateur).
//  Le GCM authentifie : une mauvaise cle ou un mauvais parametre ECHOUE,
//  il ne produit jamais un texte faux. Teste par test/secret-msg.test.js.
// ============================================================

const crypto = require('crypto');

const USAGES_EDITION = ['Message Edit'];
const USAGES_AVEC_AAD = ['Poll Vote', 'Event Response'];

function aadPour(usage, msgId, modificateurJid) {
  return USAGES_AVEC_AAD.includes(usage) ? Buffer.from(msgId + '\u0000' + modificateurJid) : Buffer.alloc(0);
}

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
  if (aad && aad.length) decipher.setAAD(aad);
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]);
}

// Inverse exact, pour les tests uniquement
function chiffrerGCM(clair, cle, iv, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', cle, iv);
  if (aad && aad.length) cipher.setAAD(aad);
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

// Essaie les combinaisons auteur x modificateur (JID anonyme ou numero : WhatsApp
// est en pleine migration, whatsmeow essaie aussi les deux) jusqu'a ce que le GCM
// valide. Retourne { octets, variante } ou null si aucune ne marche.
function dechiffrerSecretMessage({ encPayload, encIv }, { secret, msgId, auteurs, modificateurs, usages = USAGES_EDITION }) {
  if (!encPayload || !encIv || !secret || !msgId) return null;
  for (const usage of usages) {
    for (const auteur of uniques(auteurs || [])) {
      for (const modif of uniques(modificateurs || [])) {
        try {
          const cle = cleDeChiffrement(secret, msgId, auteur, modif, usage);
          const octets = dechiffrerGCM(encPayload, cle, encIv, aadPour(usage, msgId, modif));
          return { octets, variante: usage + ' / auteur ' + auteur.split('@')[1] + ' / modif ' + modif.split('@')[1] };
        } catch (e) { /* mauvaise combinaison : le GCM refuse, on essaie la suivante */ }
      }
    }
  }
  return null;
}

module.exports = { USAGES_EDITION, aadPour, cleDeChiffrement, dechiffrerGCM, chiffrerGCM, dechiffrerSecretMessage, jidSansAppareil };

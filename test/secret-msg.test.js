// ============================================================
//  Tests du dechiffrement des editions (secret-msg.js)
//    node --test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { cleDeChiffrement, chiffrerGCM, dechiffrerSecretMessage, jidSansAppareil, aadPour } = require('../secret-msg');

const SECRET = crypto.randomBytes(32);
const ID = '3EB0ABCDEF123456';
const LID = '150379807375559@lid';
const PN = '32472623827@s.whatsapp.net';

function chiffrer(clair, { auteur, modif, usage, secret = SECRET }) {
  const iv = crypto.randomBytes(12);
  const cle = cleDeChiffrement(secret, ID, auteur, modif, usage);
  return { encPayload: chiffrerGCM(Buffer.from(clair), cle, iv, aadPour(usage, ID, modif)), encIv: iv };
}

test('edition : AAD vide (whatsmeow) ; chiffre avec une AAD "sondage", ca ne passe pas', () => {
  assert.equal(aadPour('Message Edit', ID, PN).length, 0);
  assert.ok(aadPour('Poll Vote', ID, PN).length > 0);
  const iv = crypto.randomBytes(12);
  const cle = cleDeChiffrement(SECRET, ID, PN, PN, 'Message Edit');
  const avecAad = { encPayload: chiffrerGCM(Buffer.from('2A'), cle, iv, Buffer.from(ID + '\u0000' + PN)), encIv: iv };
  assert.equal(dechiffrerSecretMessage(avecAad, { secret: SECRET, msgId: ID, auteurs: [PN], modificateurs: [PN] }), null);
});

test('schema identique a decryptPollVote de Baileys (meme cle derivee)', () => {
  // Recalcul independant de la formule Baileys : hmac(secret, cle=0^32) puis hmac(sign, cle=key0)
  const sign = Buffer.concat([Buffer.from(ID), Buffer.from(PN), Buffer.from(PN), Buffer.from('Poll Vote'), Buffer.from([1])]);
  const key0 = crypto.createHmac('sha256', Buffer.alloc(32)).update(SECRET).digest();
  const attendu = crypto.createHmac('sha256', key0).update(sign).digest();
  assert.deepEqual(cleDeChiffrement(SECRET, ID, PN, PN, 'Poll Vote'), attendu);
});

test('dechiffre et trouve la bonne combinaison (auteur LID, modificateur numero)', () => {
  const enc = chiffrer('2A 1B', { auteur: LID, modif: PN, usage: 'Message Edit' });
  const r = dechiffrerSecretMessage(enc, { secret: SECRET, msgId: ID, auteurs: [PN, LID], modificateurs: [LID, PN] });
  assert.equal(r.octets.toString(), '2A 1B');
  assert.match(r.variante, /Message Edit \/ auteur lid \/ modif s\.whatsapp\.net/);
});

test('suffixe d appareil ignore', () => {
  assert.equal(jidSansAppareil('32472623827:12@s.whatsapp.net'), PN);
  const enc = chiffrer('3A', { auteur: PN, modif: PN, usage: 'Message Edit' });
  assert.equal(dechiffrerSecretMessage(enc, { secret: SECRET, msgId: ID,
    auteurs: ['32472623827:5@s.whatsapp.net'], modificateurs: ['32472623827:12@s.whatsapp.net'] }).octets.toString(), '3A');
});

test('mauvaise cle ou contenu altere : null, jamais un faux texte', () => {
  const enc = chiffrer('2A 1B', { auteur: PN, modif: PN, usage: 'Message Edit' });
  assert.equal(dechiffrerSecretMessage(enc, { secret: crypto.randomBytes(32), msgId: ID, auteurs: [PN], modificateurs: [PN] }), null);
  const altere = { ...enc, encPayload: Buffer.from(enc.encPayload) };
  altere.encPayload[0] ^= 1;
  assert.equal(dechiffrerSecretMessage(altere, { secret: SECRET, msgId: ID, auteurs: [PN], modificateurs: [PN] }), null);
  assert.equal(dechiffrerSecretMessage(enc, { secret: SECRET, msgId: 'AUTRE', auteurs: [PN], modificateurs: [PN] }), null);
});

test('libelle inconnu : null (pas de dechiffrement hasardeux)', () => {
  const enc = chiffrer('2A', { auteur: PN, modif: PN, usage: 'Libelle Inconnu' });
  assert.equal(dechiffrerSecretMessage(enc, { secret: SECRET, msgId: ID, auteurs: [PN], modificateurs: [PN] }), null);
});

test('croisement avec Baileys : chiffre ici, dechiffre par decryptPollVote de Baileys', () => {
  const { decryptPollVote, proto } = require('@whiskeysockets/baileys');
  const opt = crypto.randomBytes(32);
  const clair = proto.Message.PollVoteMessage.encode({ selectedOptions: [opt] }).finish();
  const enc = chiffrer(clair, { auteur: PN, modif: LID, usage: 'Poll Vote' });
  const vote = decryptPollVote(enc, { pollEncKey: SECRET, pollCreatorJid: PN, pollMsgId: ID, voterJid: LID });
  assert.deepEqual(Buffer.from(vote.selectedOptions[0]), opt);
});

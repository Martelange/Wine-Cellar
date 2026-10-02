// ============================================================
//  Tests de lecture des messages Baileys (whatsapp-msg.js)
//  Formes reelles observees en Baileys 7 / vente de sept. 2026.
//    node --test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { numeroAuteur, correspondanceLid, extraireEdition, extraireCitation } = require('../whatsapp-msg');

const GROUPE = '120363000000000000@g.us';

test('numero : groupe en mode LID -> vrai numero via participantAlt', () => {
  const key = { remoteJid: GROUPE, participant: '150379807375559@lid', participantAlt: '32477291699@s.whatsapp.net' };
  assert.equal(numeroAuteur(key), '32477291699');
});

test('numero : ancien format (participant = telephone, suffixe appareil)', () => {
  assert.equal(numeroAuteur({ remoteJid: GROUPE, participant: '32472623827:12@s.whatsapp.net' }), '32472623827');
});

test('numero : LID seul -> table de correspondance, sinon LID brut', () => {
  const key = { remoteJid: GROUPE, participant: '150379807375559@lid' };
  assert.equal(numeroAuteur(key, { '150379807375559': '32477291699' }), '32477291699');
  assert.equal(numeroAuteur(key, {}), '150379807375559');
});

test('correspondance LID apprise d un message', () => {
  assert.deepEqual(
    correspondanceLid({ participant: '150379807375559@lid', participantAlt: '32477291699@s.whatsapp.net' }),
    { lid: '150379807375559', numero: '32477291699' });
  assert.deepEqual(
    correspondanceLid({ participant: '32477291699@s.whatsapp.net', participantAlt: '150379807375559@lid' }),
    { lid: '150379807375559', numero: '32477291699' });
  assert.equal(correspondanceLid({ participant: '32477291699@s.whatsapp.net' }), null);
});

test('edition : forme actuelle, enveloppee dans editedMessage (bug de la vente)', () => {
  const msg = { key: { remoteJid: GROUPE, id: 'EDIT1' }, message: { editedMessage: { message: { protocolMessage: {
    type: 14, key: { id: 'ORIG1' }, editedMessage: { conversation: '2D 2b 2C -1H' } } } } } };
  assert.deepEqual(extraireEdition(msg), { idOriginal: 'ORIG1', nouveauTexte: '2D 2b 2C -1H' });
});

test('edition : ancienne forme, protocolMessage a la racine', () => {
  const msg = { key: {}, message: { protocolMessage: {
    type: 14, key: { id: 'ORIG2' }, editedMessage: { extendedTextMessage: { text: '4A /6C/ 4D / 1E' } } } } };
  assert.deepEqual(extraireEdition(msg), { idOriginal: 'ORIG2', nouveauTexte: '4A /6C/ 4D / 1E' });
});

test('edition : un message normal ou une suppression ne sont pas des editions', () => {
  assert.equal(extraireEdition({ key: {}, message: { conversation: '3A' } }), null);
  assert.equal(extraireEdition({ key: {}, message: { protocolMessage: { type: 0, key: { id: 'X' } } } }), null);
});

test('citation : reponse a un message', () => {
  const msg = { key: {}, message: { extendedTextMessage: { text: 'Correction 3b 3c 1G',
    contextInfo: { stanzaId: 'ORIG3', participant: '150379807375559@lid' } } } };
  assert.deepEqual(extraireCitation(msg), { idCite: 'ORIG3', auteurCite: '150379807375559@lid' });
  assert.equal(extraireCitation({ key: {}, message: { conversation: '3b 3c' } }), null);
});

test('structure de diagnostic : noms de champs seulement, jamais le texte', () => {
  const { structureMessage } = require('../whatsapp-msg');
  const s = structureMessage({ editedMessage: { message: { protocolMessage: {
    type: 14, key: { id: 'ORIG' }, editedMessage: { conversation: '2A 1B secret' } } } } });
  assert.deepEqual(s, { editedMessage: { message: { protocolMessage: {
    type: 14, key: { id: 'string' }, editedMessage: { conversation: 'string' } } } } });
  assert.ok(!JSON.stringify(s).includes('secret'));
});

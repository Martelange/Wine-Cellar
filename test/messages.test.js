// ============================================================
//  Tests des messages personnalisables (messages.js)
//    node --test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { MESSAGE_FIN_DEFAUT, MESSAGE_NOUVEAU_CLIENT_DEFAUT, normaliserReglages, remplirModele } = require('../messages');

test('remplit les variables connues', () => {
  const r = remplirModele('SOLD OUT en {duree} : {bouteilles} btl, {commandes} cmd',
    { duree: '3 minutes', bouteilles: 120, commandes: 25 });
  assert.equal(r, 'SOLD OUT en 3 minutes : 120 btl, 25 cmd');
});

test('variable presente plusieurs fois', () => {
  assert.equal(remplirModele('{nom} / {nom}', { nom: 'Jean' }), 'Jean / Jean');
});

test('variable inconnue laissee telle quelle', () => {
  assert.equal(remplirModele('Bonjour {prenom}', { nom: 'Jean' }), 'Bonjour {prenom}');
});

test('message par defaut de fin identique a l\'ancien texte code en dur', () => {
  const r = remplirModele(MESSAGE_FIN_DEFAUT, { duree: '2 minutes', bouteilles: 60, commandes: 12 });
  assert.equal(r, '🔥 *SOLD OUT en 2 minutes* ⚡\n\n*Un enorme merci a tous* 🙏\nVous avez ete ultra rapides !\n\n📦 *60 bouteilles* vendues\n👥 *12 commandes* enregistrees\n\nVous serez contactes prochainement. 🍷');
});

test('reglages absents -> valeurs par defaut', () => {
  assert.deepEqual(normaliserReglages(null),
    { messageFin: MESSAGE_FIN_DEFAUT, messageNouveauClient: MESSAGE_NOUVEAU_CLIENT_DEFAUT });
});

test('reglages partiels et champs parasites', () => {
  const r = normaliserReglages({ messageFin: 'Merci !', autre: 'x', messageNouveauClient: 42 });
  assert.deepEqual(r, { messageFin: 'Merci !', messageNouveauClient: MESSAGE_NOUVEAU_CLIENT_DEFAUT });
});

test('chaine vide conservee (message desactive)', () => {
  assert.equal(normaliserReglages({ messageFin: '' }).messageFin, '');
});

test('texte trop long tronque', () => {
  assert.equal(normaliserReglages({ messageFin: 'x'.repeat(5000) }).messageFin.length, 4000);
});

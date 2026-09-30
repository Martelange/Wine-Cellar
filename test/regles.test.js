// ============================================================
//  Tests des regles de validation (regles.js)
//    node --test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { dejaCommandePar, validerLignes } = require('../regles');

function vins() {
  return [
    { lettre: 'A', stockRestant: 50, min: 1, max: 6, odooId: 1 },
    { lettre: 'B', stockRestant: 2, min: 1, max: null, odooId: 2 },
    { lettre: 'C', stockRestant: 0, min: 1, max: null, odooId: 3 },
    { lettre: 'D', stockRestant: 50, min: 3, max: null, odooId: 4 },
  ];
}

test('commande simple validee telle quelle', () => {
  const r = validerLignes([{ lettre: 'A', qte: 3 }], vins(), [], '324');
  assert.deepEqual(r.lignesValidees, [{ lettre: 'A', qte: 3, odooId: 1, modifie: false }]);
  assert.equal(r.aEteModifie, false);
  assert.equal(r.aEteRefuse, false);
});

test('max cumulatif sur la vente', () => {
  const commandes = [{ numero: '324', lignes: [{ lettre: 'A', qte: 4 }] }];
  const r = validerLignes([{ lettre: 'A', qte: 6 }], vins(), commandes, '324');
  assert.equal(r.lignesValidees[0].qte, 2);
  assert.equal(r.aEteModifie, true);
});

test('edition : la commande remplacee ne compte pas dans le max (plus de double comptage)', () => {
  const commandes = [{ numero: '324', lignes: [{ lettre: 'A', qte: 6 }] }];
  // le client edite "6A" en "6A 1B" : il doit garder ses 6A
  const r = validerLignes([{ lettre: 'A', qte: 6 }, { lettre: 'B', qte: 1 }], vins(), commandes, '324', 0);
  assert.deepEqual(r.lignesValidees.map(l => [l.lettre, l.qte]), [['A', 6], ['B', 1]]);
  assert.equal(r.aEteRefuse, false);
});

test('stock epuise, min non atteint, plafond au stock', () => {
  const r = validerLignes([{ lettre: 'C', qte: 1 }, { lettre: 'D', qte: 2 }, { lettre: 'B', qte: 5 }], vins(), [], '324');
  assert.deepEqual(r.lignesValidees.map(l => [l.lettre, l.qte]), [['B', 2]]);
  assert.equal(r.aEteRefuse, true);
  assert.equal(r.aEteModifie, true);
});

test('lettre inconnue ignoree', () => {
  assert.deepEqual(validerLignes([{ lettre: 'Z', qte: 1 }], vins(), [], '324').lignesValidees, []);
});

test('dejaCommandePar ne compte que ce numero', () => {
  const commandes = [
    { numero: '324', lignes: [{ lettre: 'A', qte: 2 }] },
    { numero: '999', lignes: [{ lettre: 'A', qte: 5 }] },
    { numero: '324', lignes: [{ lettre: 'A', qte: 1 }, { lettre: 'B', qte: 1 }] },
  ];
  assert.equal(dejaCommandePar(commandes, '324', 'A'), 3);
  assert.equal(dejaCommandePar(commandes, '324', 'A', 2), 2);
});

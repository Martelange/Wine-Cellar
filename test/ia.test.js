// ============================================================
//  Tests des fonctions pures de ia.js (aucun appel reseau).
//    node --test
//  Cas exiges par TACHE-parsing-ia.md §7.
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { construirePromptSysteme, parseReponseIA } = require('../ia');

const VINS = [
  { lettre: 'A', nom: 'Pfalz Chardonnay 2025', type: 'blanc', contenant: 'bouteille' },
  { lettre: 'B', nom: 'Chablis 2024', type: 'blanc', contenant: 'magnum' },
  { lettre: 'C', nom: 'Cotes du Rhone', type: 'rouge', contenant: 'bouteille' },
];

test('construirePromptSysteme liste les vins avec lettre, nom, type, contenant', () => {
  const p = construirePromptSysteme(VINS);
  assert.match(p, /A = Pfalz Chardonnay 2025 \(blanc, bouteille\)/);
  assert.match(p, /B = Chablis 2024 \(blanc, magnum\)/);
  assert.match(p, /C = Cotes du Rhone \(rouge, bouteille\)/);
  assert.match(p, /\{"intention":"commande"/); // format de sortie decrit
});

test('construirePromptSysteme tolere une liste vide / absente', () => {
  assert.match(construirePromptSysteme([]), /aucun vin configure/);
  assert.match(construirePromptSysteme(undefined), /aucun vin configure/);
});

test('reponse JSON valide', () => {
  const r = parseReponseIA('{"intention":"commande","lignes":[{"lettre":"A","qte":6}],"confiance":0.9}', VINS);
  assert.deepEqual(r, { intention: 'commande', lignes: [{ lettre: 'A', qte: 6 }], confiance: 0.9 });
});

test('reponse avec du texte autour du JSON', () => {
  const r = parseReponseIA('Voici le resultat :\n{"intention":"commande","lignes":[{"lettre":"B","qte":2}],"confiance":0.8}\nMerci', VINS);
  assert.deepEqual(r, { intention: 'commande', lignes: [{ lettre: 'B', qte: 2 }], confiance: 0.8 });
});

test('reponse tronquee => null', () => {
  assert.equal(parseReponseIA('{"intention":"commande","lignes":[{"lettre":"A","qte":', VINS), null);
  assert.equal(parseReponseIA('', VINS), null);
  assert.equal(parseReponseIA('pas de json ici', VINS), null);
  assert.equal(parseReponseIA(null, VINS), null);
});

test('intention "autre" => lignes videes', () => {
  const r = parseReponseIA('{"intention":"autre","lignes":[{"lettre":"A","qte":3}],"confiance":0.4}', VINS);
  assert.deepEqual(r, { intention: 'autre', lignes: [], confiance: 0.4 });
});

test('intention "question" => lignes vides', () => {
  const r = parseReponseIA('{"intention":"question","lignes":[],"confiance":0.7}', VINS);
  assert.deepEqual(r, { intention: 'question', lignes: [], confiance: 0.7 });
});

test('tableau lignes vide', () => {
  const r = parseReponseIA('{"intention":"commande","lignes":[],"confiance":0.2}', VINS);
  assert.deepEqual(r, { intention: 'commande', lignes: [], confiance: 0.2 });
});

test('lettre inexistante dans la vente => ignoree, pas de plantage', () => {
  const r = parseReponseIA('{"intention":"commande","lignes":[{"lettre":"Z","qte":5},{"lettre":"A","qte":1}],"confiance":0.6}', VINS);
  assert.deepEqual(r, { intention: 'commande', lignes: [{ lettre: 'A', qte: 1 }], confiance: 0.6 });
});

test('qte hors bornes => ligne ignoree', () => {
  assert.deepEqual(
    parseReponseIA('{"intention":"commande","lignes":[{"lettre":"A","qte":0},{"lettre":"B","qte":201},{"lettre":"C","qte":2.5}],"confiance":0.5}', VINS),
    { intention: 'commande', lignes: [], confiance: 0.5 }
  );
});

test('lettre en minuscule normalisee, doublon de lettre ignore', () => {
  const r = parseReponseIA('{"intention":"commande","lignes":[{"lettre":"a","qte":3},{"lettre":"A","qte":9}],"confiance":1}', VINS);
  assert.deepEqual(r, { intention: 'commande', lignes: [{ lettre: 'A', qte: 3 }], confiance: 1 });
});

test('confiance bornée à [0,1] et defaut 0', () => {
  assert.equal(parseReponseIA('{"intention":"autre","confiance":5}', VINS).confiance, 1);
  assert.equal(parseReponseIA('{"intention":"autre","confiance":-2}', VINS).confiance, 0);
  assert.equal(parseReponseIA('{"intention":"autre"}', VINS).confiance, 0);
  assert.equal(parseReponseIA('{"intention":"autre","confiance":"oui"}', VINS).confiance, 0);
});

test('intention inconnue => "autre"', () => {
  assert.equal(parseReponseIA('{"intention":"achat","lignes":[],"confiance":0.9}', VINS).intention, 'autre');
});

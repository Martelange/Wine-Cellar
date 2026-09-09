// ============================================================
//  Tests de caracterisation de parseCommandeMulti
//  But : verrouiller le comportement ACTUEL du regex avant toute
//  modification (extraction, puis chantier IA). Runner natif Node.
//    node --test
//
//  NB : certains cas de TACHE-parsing-ia.md §7 sont des SOUHAITS,
//  pas le comportement actuel. Ils sont marques [DIVERGE] ci-dessous
//  et resteront tels quels tant que le chantier IA ne les traite pas.
//  Ne pas "corriger" le regex sans demander (CLAUDE.md §5).
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommandeMulti } = require('../parsing');

function eq(input, expected) {
  assert.deepEqual(parseCommandeMulti(input), expected);
}

test('formes de base quantite + lettre', () => {
  eq('3A', [{ lettre: 'A', qte: 3 }]);
  eq('3 A', [{ lettre: 'A', qte: 3 }]);
  eq('a3', [{ lettre: 'A', qte: 3 }]);
  eq('A 3', [{ lettre: 'A', qte: 3 }]);
  eq('A6', [{ lettre: 'A', qte: 6 }]);
});

test('plusieurs vins dans un message', () => {
  eq('2A 3B', [{ lettre: 'A', qte: 2 }, { lettre: 'B', qte: 3 }]);
  eq('2A 3B 1C', [{ lettre: 'A', qte: 2 }, { lettre: 'B', qte: 3 }, { lettre: 'C', qte: 1 }]);
  eq('6A 3B 2C', [{ lettre: 'A', qte: 6 }, { lettre: 'B', qte: 3 }, { lettre: 'C', qte: 2 }]);
});

test('commande collee sans espaces', () => {
  eq('12a2b4c2d', [
    { lettre: 'A', qte: 12 }, { lettre: 'B', qte: 2 },
    { lettre: 'C', qte: 4 }, { lettre: 'D', qte: 2 },
  ]);
  eq('3a2b', [{ lettre: 'A', qte: 3 }, { lettre: 'B', qte: 2 }]);
});

test('commande au milieu d\'une phrase, mots parasites retires', () => {
  eq('je prends 6A stp merci', [{ lettre: 'A', qte: 6 }]);
  eq('bonjour, je voudrais 2A et 3B svp', [{ lettre: 'A', qte: 2 }, { lettre: 'B', qte: 3 }]);
});

test('accents ignores', () => {
  eq('3À', [{ lettre: 'A', qte: 3 }]);
});

test('une seule occurrence par lettre (la premiere)', () => {
  eq('3A 2A', [{ lettre: 'A', qte: 3 }]);
});

test('quantites hors bornes', () => {
  eq('0A', null);
  eq('999A', null);
  eq('201A', null);
  eq('200A', [{ lettre: 'A', qte: 200 }]);
  eq('1A', [{ lettre: 'A', qte: 1 }]);
});

test('messages sans commande => null', () => {
  eq('bonjour', null);
  eq('merci', null);
  eq('pareil que la derniere fois', null);
  eq('il reste du B ?', null);
  eq('', null);
});

// ---- [DIVERGE] comportement actuel != souhait de TACHE-parsing-ia.md §7 ----
// Ces assertions documentent le bug connu. Le chantier IA (phase 1) doit
// faire remonter ces messages au dashboard au lieu de les perdre.

test('[DIVERGE] "3 x C 1 x D" : le "x" est capture comme une lettre', () => {
  // Souhaite : [{C:3},{D:1}]. Actuel :
  eq('3 x C 1 x D', [{ lettre: 'X', qte: 3 }, { lettre: 'C', qte: 1 }]);
});

test('[DIVERGE] "6 magnums de A" : reference au vin par mot => non parse', () => {
  // Souhaite (a trancher) : [{A:6}]. Actuel :
  eq('6 magnums de A', null);
});

test('[DIVERGE] "6 bouteilles du rouge" : reference par type => non parse', () => {
  eq('6 bouteilles du rouge', null);
});

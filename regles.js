// ============================================================
//  REGLES DE VALIDATION D'UNE COMMANDE — fonctions pures, testables
//  (test/regles.test.js). Utilisees a l'identique par une commande
//  normale, une edition de message et une "correction" en reponse :
//  les chemins ne peuvent plus diverger.
// ============================================================

// Quantite deja commandee par ce numero pour cette lettre sur toute la vente.
// indexExclu : la commande en cours de remplacement (edition / correction),
// qui ne doit pas compter dans le max.
function dejaCommandePar(commandes, numero, lettre, indexExclu = -1) {
  let total = 0;
  commandes.forEach((cmd, i) => {
    if (i === indexExclu || cmd.numero !== numero) return;
    const ligne = cmd.lignes.find(l => l.lettre === lettre);
    if (ligne) total += ligne.qte;
  });
  return total;
}

// Applique stock, min et max cumulatif aux lignes parsees. Ne modifie rien :
// le decrement du stock est fait par l'appelant, apres validation.
function validerLignes(lignesParsees, vins, commandes, numero, indexExclu = -1) {
  const lignesValidees = [];
  let aEteModifie = false;
  let aEteRefuse = false;

  for (const { lettre, qte } of lignesParsees) {
    const qteOriginale = qte;
    const vin = vins.find(v => v.lettre === lettre);
    if (!vin) continue;
    if (vin.stockRestant <= 0) { aEteRefuse = true; continue; }
    if (vin.min && qte < vin.min) { aEteRefuse = true; continue; }

    let qteFinale = qte;
    let modifie = false;
    if (vin.max) {
      const resteAutorise = vin.max - dejaCommandePar(commandes, numero, lettre, indexExclu);
      if (resteAutorise <= 0) { aEteRefuse = true; continue; }
      if (qteFinale > resteAutorise) { qteFinale = resteAutorise; modifie = true; aEteModifie = true; }
    }
    if (qteFinale > vin.stockRestant) { qteFinale = vin.stockRestant; aEteModifie = true; modifie = true; }
    lignesValidees.push({ lettre, qte: qteFinale, odooId: vin.odooId, modifie: modifie || qteFinale < qteOriginale });
  }
  return { lignesValidees, aEteModifie, aEteRefuse };
}

module.exports = { dejaCommandePar, validerLignes };

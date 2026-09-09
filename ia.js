// ============================================================
//  ANALYSE IA DES MESSAGES — Phase 1 (observation seule)
//
//  bot_multi.js appelle analyserMessageIA() quand parseCommandeMulti()
//  echoue sur un message recu pendant une vente active. L'IA ne fait
//  QUE traduire du texte en intentions : elle ne decide rien, ne touche
//  pas au stock, et n'envoie JAMAIS de message WhatsApp.
//
//  - Modele : Claude Haiku 4.5 (le moins cher / le plus rapide)
//  - Timeout dur 3 s, degradation silencieuse vers null en cas d'echec
//  - Desactive entierement si ANTHROPIC_API_KEY est absente
//  - Aucune dependance npm : fetch + AbortController natifs (Node 20+)
//
//  Fonctions pures (testees sans reseau, voir test/ia.test.js) :
//    construirePromptSysteme(vins) / parseReponseIA(texte, vins)
// ============================================================

const IA_MODELE = 'claude-haiku-4-5';
const IA_TIMEOUT_MS = 3000;
const IA_MAX_TOKENS = 300;
// Garde-fou cout : nombre max d'appels IA par vente (compteur dans state.iaAppels).
const IA_MAX_APPELS_PAR_VENTE = 150;

function iaActivee() {
  return !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
}

// --- PUR : construction du prompt systeme -------------------------------------
function construirePromptSysteme(vins) {
  const liste = (Array.isArray(vins) ? vins : [])
    .filter(v => v && v.lettre)
    .map(v => {
      const bouts = [];
      if (v.type) bouts.push(v.type);
      if (v.contenant) bouts.push(v.contenant);
      const suffixe = bouts.length ? ' (' + bouts.join(', ') + ')' : '';
      return '- ' + v.lettre + ' = ' + (v.nom || '(sans nom)') + suffixe;
    })
    .join('\n');

  return [
    "Tu analyses un seul message recu dans un groupe WhatsApp de vente flash de vin.",
    "Ton unique role : dire si le message est une commande, une question, ou autre chose,",
    "et si c'est une commande, extraire les quantites par vin.",
    "",
    "Vins de la vente en cours (la lettre est la reference a utiliser) :",
    liste || "(aucun vin configure)",
    "",
    "Reponds STRICTEMENT par un objet JSON, sans aucun texte autour, de la forme :",
    '{"intention":"commande","lignes":[{"lettre":"A","qte":6}],"confiance":0.9}',
    "",
    "Regles :",
    '- "intention" vaut "commande" (le message veut acheter), "question" (il demande une info :',
    '  stock, prix, disponibilite...), ou "autre" (bonjour, merci, hors sujet).',
    '- "lignes" : uniquement si intention = "commande", sinon [].',
    '- "lettre" : une des lettres ci-dessus, en MAJUSCULE. Ignore toute reference a un vin',
    "  qui n'est pas dans la liste.",
    '- "qte" : entier entre 1 et 200.',
    '- "6 du rouge", "le Chablis", "2 magnums du B" => resous vers la bonne lettre via la liste.',
    '- "confiance" : nombre entre 0 et 1, ta certitude sur intention + lignes.',
    "- En cas de doute serieux, mets une confiance basse plutot que d'inventer.",
  ].join('\n');
}

// --- PUR : parsing de la reponse du modele -----------------------------------
function parseReponseIA(texte, vins) {
  if (typeof texte !== 'string') return null;
  const debut = texte.indexOf('{');
  const fin = texte.lastIndexOf('}');
  if (debut === -1 || fin === -1 || fin < debut) return null;

  let obj;
  try { obj = JSON.parse(texte.slice(debut, fin + 1)); }
  catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const intention = ['commande', 'question', 'autre'].includes(obj.intention)
    ? obj.intention : 'autre';

  const lettresValides = new Set(
    (Array.isArray(vins) ? vins : []).map(v => v && v.lettre).filter(Boolean)
  );

  let lignes = [];
  if (intention === 'commande' && Array.isArray(obj.lignes)) {
    for (const l of obj.lignes) {
      if (!l || typeof l !== 'object') continue;
      const lettre = String(l.lettre == null ? '' : l.lettre).toUpperCase();
      const qte = Number(l.qte);
      if (!lettresValides.has(lettre)) continue;
      if (!Number.isInteger(qte) || qte < 1 || qte > 200) continue;
      if (lignes.some(x => x.lettre === lettre)) continue;
      lignes.push({ lettre, qte });
    }
  }

  let confiance = Number(obj.confiance);
  if (!Number.isFinite(confiance)) confiance = 0;
  confiance = Math.max(0, Math.min(1, confiance));

  return { intention, lignes, confiance };
}

// --- IMPUR : appel reseau (jamais bloquant, jamais throw) --------------------
async function analyserMessageIA(body, vins) {
  if (!iaActivee()) return null;
  const texteMsg = String(body == null ? '' : body).trim();
  if (!texteMsg) return null;

  const controller = new AbortController();
  const minuteur = setTimeout(() => controller.abort(), IA_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: IA_MODELE,
        max_tokens: IA_MAX_TOKENS,
        temperature: 0,
        system: construirePromptSysteme(vins),
        messages: [{ role: 'user', content: texteMsg.slice(0, 2000) }],
      }),
    });
    if (!res.ok) { console.log('[IA] reponse HTTP', res.status); return null; }
    const data = await res.json();
    const texte = Array.isArray(data && data.content)
      ? data.content.filter(b => b && b.type === 'text').map(b => b.text).join('')
      : '';
    return parseReponseIA(texte, vins);
  } catch (e) {
    console.log('[IA] echec :', e && e.name === 'AbortError' ? 'timeout ' + IA_TIMEOUT_MS + 'ms' : (e && e.message));
    return null;
  } finally {
    clearTimeout(minuteur);
  }
}

module.exports = {
  iaActivee,
  construirePromptSysteme,
  parseReponseIA,
  analyserMessageIA,
  IA_MODELE,
  IA_MAX_APPELS_PAR_VENTE,
};

// ============================================================
//  WINE CELLAR – Bot WhatsApp Ventes Flash MULTI-VINS
//  MODE SILENCIEUX — monitoring uniquement, aucune action WA
// ============================================================

require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'moncode123';
const GROUPE_ID = process.env.GROUPE_ID || '';

const DATA_FILE = path.join(__dirname, 'vente_en_cours.json');
const CLIENTS_FILE = path.join(__dirname, 'clients_odoo.json');

const DELAI_MERCI = 20000;

const TAGS_TYPE = { rouge: 'ROUGE', blanc: 'BLANC', rose: 'ROSÉ', orange: 'ORANGE', petillant: 'PÉTILLANT' };

function chargerClients() {
  if (fs.existsSync(CLIENTS_FILE)) {
    try { return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')); }
    catch { return {}; }
  }
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify({}, null, 2));
  return {};
}
let clientsOdoo = chargerClients();

function etatInitial() {
  return {
    texteLibre: '', vins: [], commandes: [], venteActive: false,
    dateVente: new Date().toISOString(), heureDebut: null,
    seuil50envoye: false, seuil20envoye: false
  };
}

function chargerEtat() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const etat = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      etat.venteActive = false;
      return etat;
    }
    catch { return etatInitial(); }
  }
  return etatInitial();
}

let state = chargerEtat();

function sauvegarderEtat() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function formatDuree(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return sec + ' secondes';
  if (sec === 0) return min + ' minute' + (min > 1 ? 's' : '');
  return min + ' minute' + (min > 1 ? 's' : '') + ' et ' + sec + ' secondes';
}

function stockTotalRestant() {
  return state.vins.reduce((s, v) => s + v.stockRestant, 0);
}

function stockTotalInitial() {
  return state.vins.reduce((s, v) => s + v.stock, 0);
}

function dejaCommandePar(numero, lettre) {
  let total = 0;
  for (const cmd of state.commandes) {
    if (cmd.numero === numero) {
      const ligne = cmd.lignes.find(l => l.lettre === lettre);
      if (ligne) total += ligne.qte;
    }
  }
  return total;
}

// ---------- PARSING MULTI-VINS ----------
const MOTS_IGNORES = /\b(stp|svp|aub|merci|please|et|en|s'il|vous|plait|si)\b/gi;

function parseCommandeMulti(msgBody) {
  const txt = msgBody
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(MOTS_IGNORES, ' ')
    .replace(/[,;\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const resultats = [];
  const pattern = /(\d+)\s*([a-z])\b|([a-z])\s*(\d+)\b/g;
  let match;

  while ((match = pattern.exec(txt)) !== null) {
    let qte, lettre;
    if (match[1] && match[2]) { qte = parseInt(match[1]); lettre = match[2].toUpperCase(); }
    else if (match[3] && match[4]) { qte = parseInt(match[4]); lettre = match[3].toUpperCase(); }
    if (qte && lettre && qte > 0 && qte <= 200) {
      if (!resultats.find(r => r.lettre === lettre)) resultats.push({ lettre, qte });
    }
  }

  return resultats.length > 0 ? resultats : null;
}

// ---------- RESOLUTION NUMERO ----------
async function getNumeroReel(msg) {
  const brut = msg.author || msg.from;
  if (brut.includes('@lid')) {
    try {
      const contact = await msg.getContact();
      if (contact.id && contact.id.user) return contact.id.user;
      if (contact.number) return contact.number;
    } catch (e) {
      return brut.replace(/@lid/g, '');
    }
  }
  return brut.replace(/@c\.us|@g\.us/g, '').replace(/\D/g, '');
}

// ---------- MESSAGE D'ANNONCE (pour dashboard seulement) ----------
function construireMessageVente() {
  const CONTENANTS_SING = { bouteille: 'bouteille', magnum: 'magnum', jeroboam: 'jéroboam' };
  const CONTENANTS_PLUR = { bouteille: 'bouteilles', magnum: 'magnums', jeroboam: 'jéroboams' };
  const CONTENANTS_ABR  = { bouteille: 'btl.', magnum: 'mag.', jeroboam: 'jer.' };

  let msg = '';
  if (state.texteLibre) msg += state.texteLibre + '\n\n';
  msg += '─'.repeat(30) + '\n';

  state.vins.forEach(vin => {
    const abrv = CONTENANTS_ABR[vin.contenant] || 'btl.';
    const plur = CONTENANTS_PLUR[vin.contenant] || 'bouteilles';
    const sing = CONTENANTS_SING[vin.contenant] || 'bouteille';
    const typeTag = vin.type ? (TAGS_TYPE[vin.type] || '') + ' - ' : '';

    msg += '\n*' + vin.lettre + '.* ' + typeTag + vin.nom + ' — ' + vin.prix + '€/' + abrv + '\n';
    msg += '   📦 ' + vin.stock + ' ' + plur + ' disponibles\n';
    if (vin.max) msg += '   ⬆️ Maximum ' + vin.max + ' ' + (vin.max > 1 ? plur : sing) + ' par personne\n';
    if (vin.min && vin.min > 1) msg += '   ⬇️ Minimum ' + vin.min + ' ' + (vin.min > 1 ? plur : sing) + ' par commande\n';
  });

  msg += '\n' + '─'.repeat(30) + '\n';
  msg += '\n📝 *Comment commander ?*\n';
  msg += '   *Quantité + Lettre* pour chaque vin souhaité\n';
  msg += '   Ex: *3A* — *6B* — *2A 3B* — *6A 3B 2C*\n\n';
  msg += '👍 All good — commande validée telle quelle\n';
  msg += '👇 Commande modifiée (règles ou fin de stock)\n';
  msg += '❌ Commande refusée\n';
  msg += '📧 Facture envoyée par mail ultérieurement';

  return msg;
}

function construireMessageStocks() {
  const CONTENANTS_PLUR = { bouteille: 'bouteilles', magnum: 'magnums', jeroboam: 'jéroboams' };
  const duree = state.heureDebut ? formatDuree(Date.now() - state.heureDebut) : '?';

  let msg = '📊 *État des stocks* — ' + duree + ' après le lancement\n';
  msg += '─'.repeat(30) + '\n\n';

  state.vins.forEach(vin => {
    const plur = CONTENANTS_PLUR[vin.contenant] || 'bouteilles';
    const pct = vin.stock > 0 ? Math.round((vin.stockRestant / vin.stock) * 100) : 0;
    const vendues = vin.stock - vin.stockRestant;
    let emoji = '🟢';
    if (pct <= 20) emoji = '🔴';
    else if (pct <= 50) emoji = '🟡';

    if (vin.stockRestant === 0) {
      msg += emoji + ' *' + vin.lettre + '.* ' + vin.nom + '\n';
      msg += '   🔴 SOLD OUT (' + vendues + ' ' + plur + ' vendus)\n\n';
    } else {
      msg += emoji + ' *' + vin.lettre + '.* ' + vin.nom + '\n';
      msg += '   ' + vin.stockRestant + ' ' + plur + ' restants — *' + pct + '%* disponible\n\n';
    }
  });

  const totalRestant = stockTotalRestant();
  const totalInitial = stockTotalInitial();
  const totalPct = totalInitial > 0 ? Math.round((totalRestant / totalInitial) * 100) : 0;
  msg += '─'.repeat(30) + '\n';
  msg += '🍷 *Total : ' + totalRestant + ' bouteilles restantes (' + totalPct + '%)*';

  return msg;
}

// ---------- SEUILS — LOG UNIQUEMENT ----------
async function verifierSeuils() {
  const restant = stockTotalRestant();
  const total = stockTotalInitial();
  if (total === 0) return;
  const pct = (restant / total) * 100;
  const duree = state.heureDebut ? formatDuree(Date.now() - state.heureDebut) : '?';
  const vendues = total - restant;

  if (!state.seuil50envoye && pct <= 50) {
    state.seuil50envoye = true;
    sauvegarderEtat();
    // 🔇 MODE SILENCIEUX — pas d'envoi WhatsApp
    console.log('\ud83d\udfe1 [SILENCIEUX] Mi-parcours : ' + vendues + ' vendues en ' + duree + ', ' + restant + ' restantes');
    io.emit('seuil', { type: '50', vendues, restant, duree });
  }

  if (!state.seuil20envoye && pct <= 20) {
    state.seuil20envoye = true;
    sauvegarderEtat();
    // 🔇 MODE SILENCIEUX — pas d'envoi WhatsApp
    console.log('\ud83d\udd34 [SILENCIEUX] Plus que ' + restant + ' bouteilles après ' + duree);
    io.emit('seuil', { type: '20', vendues, restant, duree });
  }
}

// ---------- EXPRESS + SOCKET.IO ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === DASHBOARD_PASSWORD) return next();
  res.status(401).json({ error: 'Non autorise' });
}

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) res.json({ ok: true, token: DASHBOARD_PASSWORD });
  else res.status(401).json({ error: 'Code incorrect' });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/etat', requireAuth, (req, res) => res.json(state));
app.get('/api/clients', requireAuth, (req, res) => res.json(clientsOdoo));

app.post('/api/clients', requireAuth, (req, res) => {
  const { numero, odoo_id, nom } = req.body;
  if (!numero || !odoo_id) return res.status(400).json({ error: 'Invalide' });
  const clean = numero.replace(/\D/g, '');
  clientsOdoo[clean] = { odoo_id: parseInt(odoo_id), nom: nom || '' };
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clientsOdoo, null, 2));
  res.json({ ok: true });
});

app.delete('/api/clients/:numero', requireAuth, (req, res) => {
  delete clientsOdoo[req.params.numero.replace(/\D/g, '')];
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clientsOdoo, null, 2));
  res.json({ ok: true });
});

// Demarrer la vente — PAS d'envoi WhatsApp
app.post('/api/nouvelle-vente', requireAuth, async (req, res) => {
  const { texteLibre, vins } = req.body;
  if (!vins || vins.length === 0) return res.status(400).json({ error: 'Aucun vin defini' });

  const LABELS_TYPE = { rouge: 'ROUGE', blanc: 'BLANC', rose: 'ROSÉ', orange: 'ORANGE', petillant: 'PÉTILLANT' };

  const vinsAvecLettres = vins.map((vin, i) => ({
    lettre: String.fromCharCode(65 + i),
    nom: vin.nom || '', prix: vin.prix || '',
    type: vin.type || '',
    contenant: vin.contenant || 'bouteille',
    stock: parseInt(vin.stock) || 0,
    stockRestant: parseInt(vin.stock) || 0,
    min: parseInt(vin.min) || 1,
    max: parseInt(vin.max) || null,
    odooId: vin.odooId || null
  }));

  state = etatInitial();
  state.texteLibre = texteLibre || '';
  state.vins = vinsAvecLettres;
  state.venteActive = true;
  state.dateVente = new Date().toISOString();
  state.heureDebut = Date.now();
  sauvegarderEtat();
  io.emit('update', state);

  // 🔇 MODE SILENCIEUX — pas d'envoi WhatsApp
  console.log('\n\ud83d\udd07 [SILENCIEUX] Vente démarrée (' + vinsAvecLettres.length + ' vins) — aucun message envoyé sur WhatsApp');
  console.log('   Message qui aurait été envoyé :');
  console.log(construireMessageVente());

  res.json({ ok: true, silent: true });
});

app.post('/api/stopper', requireAuth, (req, res) => {
  state.venteActive = false;
  sauvegarderEtat();
  io.emit('update', state);
  res.json({ ok: true });
});

// Envoyer état des stocks — 🔇 LOG UNIQUEMENT
app.post('/api/envoyer-stocks', requireAuth, async (req, res) => {
  if (state.vins.length === 0) return res.status(400).json({ error: 'Aucune vente en cours' });
  // 🔇 MODE SILENCIEUX — affiche dans le terminal mais n'envoie pas
  console.log('\n\ud83d\udd07 [SILENCIEUX] État des stocks (non envoyé) :');
  console.log(construireMessageStocks());
  res.json({ ok: true, silent: true });
});

app.get('/api/historique-edits', requireAuth, (req, res) => {
  res.json(state.historique_edits || []);
});

// ✅ Vérification des doublons suspects
app.get('/api/doublons', requireAuth, (req, res) => {
  res.json(detecterDoublons());
});

// ✅ Ajouter une commande manuellement
app.post('/api/commande-manuelle', requireAuth, (req, res) => {
  const { numero, nom, lignes } = req.body;
  if (!numero || !lignes || lignes.length === 0) return res.status(400).json({ error: 'Invalide' });

  const lignesValidees = [];
  for (const { lettre, qte } of lignes) {
    const vin = state.vins.find(v => v.lettre === lettre.toUpperCase());
    if (!vin) continue;
    const qteFin = Math.min(parseInt(qte) || 0, vin.stockRestant);
    if (qteFin <= 0) continue;
    vin.stockRestant -= qteFin;
    lignesValidees.push({ lettre: lettre.toUpperCase(), qte: qteFin, odooId: vin.odooId, manuel: true });
  }

  if (lignesValidees.length === 0) return res.status(400).json({ error: 'Aucune ligne valide' });

  const commande = {
    id: Date.now(),
    heure: new Date().toLocaleTimeString('fr-BE'),
    numero: numero.replace(/\D/g, ''),
    nom: nom || '',
    lignes: lignesValidees,
    source: 'manuel',
    msgOriginal: '[Ajout manuel]',
    manuel: true
  };

  state.commandes.push(commande);
  sauvegarderEtat();
  io.emit('update', state);
  io.emit('nouvelle_commande', commande);
  console.log('\u270f\ufe0f [MANUEL] Commande ajoutée :', nom, lignesValidees.map(l => l.lettre + ':' + l.qte).join(' | '));
  res.json({ ok: true });
});

// ✅ Supprimer une commande par index
app.delete('/api/commande/:index', requireAuth, (req, res) => {
  const idx = parseInt(req.params.index);
  if (isNaN(idx) || idx < 0 || idx >= state.commandes.length) return res.status(400).json({ error: 'Index invalide' });

  const commande = state.commandes[idx];
  // Remettre le stock
  for (const ligne of commande.lignes) {
    const vin = state.vins.find(v => v.lettre === ligne.lettre);
    if (vin) vin.stockRestant += ligne.qte;
  }

  state.commandes.splice(idx, 1);
  sauvegarderEtat();
  io.emit('update', state);
  console.log('\ud83d\uddd1\ufe0f [SUPPRESSION] Commande supprimée :', commande.nom || commande.numero);
  res.json({ ok: true });
});

// ✅ Marquer une commande comme suspecte
app.patch('/api/commande/:index/suspect', requireAuth, (req, res) => {
  const idx = parseInt(req.params.index);
  if (isNaN(idx) || idx < 0 || idx >= state.commandes.length) return res.status(400).json({ error: 'Index invalide' });
  state.commandes[idx].suspect = !state.commandes[idx].suspect;
  sauvegarderEtat();
  io.emit('update', state);
  res.json({ ok: true, suspect: state.commandes[idx].suspect });
});

app.get('/api/export', requireAuth, (req, res) => {
  const map = {};
  for (const cmd of state.commandes) {
    for (const ligne of cmd.lignes) {
      const key = cmd.numero + '|' + ligne.lettre;
      if (!map[key]) {
        const vin = state.vins.find(v => v.lettre === ligne.lettre);
        const cl = clientsOdoo[cmd.numero] || {};
        map[key] = {
          odooClientId: cl.odoo_id || '',
          telephone: '+' + cmd.numero,
          nom: cl.nom || cmd.nom || '',
          lettre: ligne.lettre,
          type: vin ? (vin.type || '') : '',
          vinNom: vin ? vin.nom : '',
          odooProduittId: vin ? (vin.odooId || '') : '',
          qteTotal: 0,
          prix: vin ? vin.prix : '',
          contenant: vin ? vin.contenant : '',
          date: state.dateVente.slice(0, 10)
        };
      }
      map[key].qteTotal += ligne.qte;
    }
  }

  const lignes = Object.values(map).sort((a, b) => {
    const nomCmp = (a.nom || a.telephone).localeCompare(b.nom || b.telephone);
    return nomCmp !== 0 ? nomCmp : a.lettre.localeCompare(b.lettre);
  });

  const headers = 'Odoo_Client_ID,Telephone,Nom,Lettre,Type,Vin,Odoo_Produit_ID,Quantite_Totale,Prix_Unit,Contenant,Date';
  const csv = '\uFEFF' + headers + '\r\n' + lignes.map(l =>
    [l.odooClientId, l.telephone, l.nom, l.lettre, l.type, l.vinNom,
     l.odooProduittId, l.qteTotal, l.prix, l.contenant, l.date]
    .map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')
  ).join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="vente_consolidee_' + state.dateVente.slice(0, 10) + '.csv"');
  res.send(csv);
});

// ✅ Anti-doublon : garde en mémoire les messages récemment traités (id + timestamp)
const messagesTraites = new Map(); // msgId → timestamp

function estDejaTraite(msgId) {
  if (messagesTraites.has(msgId)) return true;
  messagesTraites.set(msgId, Date.now());
  // Nettoyage des entrées > 10 secondes
  for (const [id, ts] of messagesTraites) {
    if (Date.now() - ts > 10000) messagesTraites.delete(id);
  }
  return false;
}

// ✅ Détection de doublons suspects dans les commandes existantes
function detecterDoublons() {
  const suspects = [];
  for (let i = 0; i < state.commandes.length; i++) {
    for (let j = i + 1; j < state.commandes.length; j++) {
      const a = state.commandes[i];
      const b = state.commandes[j];
      if (a.numero !== b.numero) continue;
      if (a.msgOriginal !== b.msgOriginal) continue;
      // Même numéro, même message original — suspect
      suspects.push({ indexA: i, indexB: j, numero: a.numero, nom: a.nom, message: a.msgOriginal });
    }
  }
  return suspects;
}

// ---------- TRAITEMENT D'UNE COMMANDE ----------
async function traiterCommande(msg, body, numeroContact, nom, estDuGroupe) {
  const lignesParsees = parseCommandeMulti(body);
  if (!lignesParsees) return;

  // ✅ Anti-doublon : ignore si ce message a déjà été traité dans les 10 dernières secondes
  const msgId = (msg.id && msg.id._serialized) ? msg.id._serialized : (numeroContact + '|' + body);
  if (estDejaTraite(msgId)) {
    console.log('\u26a0\ufe0f [DOUBLON IGNORE] :', msgId.slice(0, 40));
    return;
  }

  const lignesValidees = [];
  let aEteModifie = false;
  let aEteRefuse = false;

  for (const { lettre, qte } of lignesParsees) {
    const vin = state.vins.find(v => v.lettre === lettre);
    if (!vin || vin.stockRestant <= 0) continue;
    if (vin.min && qte < vin.min) { aEteRefuse = true; continue; }

    let qteFinale = qte;
    let modifie = false;
    if (vin.max) {
      const dejaCommande = dejaCommandePar(numeroContact, lettre);
      const resteAutorise = vin.max - dejaCommande;
      if (resteAutorise <= 0) { aEteRefuse = true; continue; }
      if (qteFinale > resteAutorise) { qteFinale = resteAutorise; modifie = true; aEteModifie = true; }
    }
    qteFinale = Math.min(qteFinale, vin.stockRestant);
    lignesValidees.push({ lettre, qte: qteFinale, odooId: vin.odooId, modifie });
  }

  if (lignesValidees.length > 0) {
    const reaction = (aEteModifie || aEteRefuse) ? '\ud83d\udc47' : '\ud83d\udc4d';
    console.log('\ud83d\udd07 [SILENCIEUX] Réaction : ' + reaction);
  } else if (aEteRefuse) {
    console.log('\ud83d\udd07 [SILENCIEUX] Réaction : ❌');
    return;
  } else { return; }

  for (const ligne of lignesValidees) {
    const vin = state.vins.find(v => v.lettre === ligne.lettre);
    if (vin) vin.stockRestant -= ligne.qte;
  }

  const commande = {
    heure: new Date().toLocaleTimeString('fr-BE'),
    numero: numeroContact, nom,
    lignes: lignesValidees,
    source: estDuGroupe ? 'groupe' : 'privé',
    msgOriginal: body
  };

  state.commandes.push(commande);
  sauvegarderEtat();
  io.emit('update', state);
  io.emit('nouvelle_commande', commande);

  const resume = lignesValidees.map(l => l.lettre + ':' + l.qte + (l.modifie ? '(max)' : '')).join(' | ');
  console.log('\u2705 [' + commande.heure + '] ' + (nom || numeroContact) + ' → ' + resume + ' | Restant : ' + stockTotalRestant());
  await verifierSeuils();
}

// ---------- WHATSAPP ----------
let whatsappClient;

function demarrerWhatsApp() {
  if (!GROUPE_ID) console.log('\u26a0\ufe0f GROUPE_ID non defini dans le .env !');

  whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  whatsappClient.on('qr', qr => {
    console.log('\n\ud83d\udcf1 Scanne ce QR code :\n');
    qrcode.generate(qr, { small: true });
    io.emit('qr_needed');
  });

  whatsappClient.on('ready', () => {
    console.log('\n\u2705 Bot connecté ! Numéro :', whatsappClient.info.wid.user);
    console.log('\ud83d\udd07 MODE SILENCIEUX — aucune action sur WhatsApp');
    console.log('\ud83c\udf10 Dashboard : http://localhost:' + PORT + '\n');
    io.emit('whatsapp_ready');
  });

  whatsappClient.on('message', async msg => {
    if (msg.fromMe) return;

    // ── MODE DEBUG ──────────────────────────────────────────
    // console.log('👁 MSG DE :', msg.from, '|', msg.body.slice(0, 50));
    // ────────────────────────────────────────────────────────

    if (!state.venteActive) return;

    const estDuGroupe = msg.from === GROUPE_ID;
    const estMessagePrive = !msg.from.includes('@g.us');
    if (!estDuGroupe && !estMessagePrive) return;

    const numeroContact = await getNumeroReel(msg);
    const nom = (msg._data && msg._data.notifyName) || (clientsOdoo[numeroContact] && clientsOdoo[numeroContact].nom) || '';

    await traiterCommande(msg, msg.body, numeroContact, nom, estDuGroupe);

    if (stockTotalRestant() === 0) {
      state.venteActive = false;
      sauvegarderEtat();
      io.emit('sold_out');
      console.log('\ud83d\udd07 [SILENCIEUX] SOLD OUT — aucun message envoyé sur WhatsApp');
    }
  });

  whatsappClient.on('message_edit', async (msg, newBody, oldBody) => {
    if (msg.fromMe) return;
    if (!state.venteActive) {
      console.log('\ud83d\udd07 [EDIT IGNORE] Vente terminée — modification ignorée');
      return;
    }

    const estDuGroupe = msg.from === GROUPE_ID;
    const estMessagePrive = !msg.from.includes('@g.us');
    if (!estDuGroupe && !estMessagePrive) return;

    const numeroContact = await getNumeroReel(msg);
    const nom = (msg._data && msg._data.notifyName) || (clientsOdoo[numeroContact] && clientsOdoo[numeroContact].nom) || '';

    console.log('\u270f\ufe0f [EDIT] ' + (nom || numeroContact) + ' | "' + oldBody + '" → "' + newBody + '"');

    // Trouver la commande originale liée à ce message
    const cmdIndex = state.commandes.findIndex(c =>
      c.numero === numeroContact && c.msgOriginal === oldBody
    );

    // Logger la modification dans tous les cas
    const entreeHistorique = {
      heure: new Date().toLocaleTimeString('fr-BE'),
      numero: numeroContact,
      nom,
      ancienMessage: oldBody,
      nouveauMessage: newBody,
      action: ''
    };

    if (cmdIndex === -1) {
      // Pas de commande originale trouvée — peut-être un message non reconnu edité
      const nouvellesLignes = parseCommandeMulti(newBody);
      if (nouvellesLignes) {
        // Le nouveau message est une commande valide — on la traite comme nouvelle commande
        entreeHistorique.action = 'nouveau_depuis_edit';
        console.log('\u270f\ufe0f [EDIT] Pas de commande originale — traitement comme nouvelle commande');
        // Traitement identique au handler message normal
        await traiterCommande(msg, newBody, numeroContact, nom, estDuGroupe);
      } else {
        entreeHistorique.action = 'ignore_pas_commande';
      }
      state.historique_edits = state.historique_edits || [];
      state.historique_edits.push(entreeHistorique);
      sauvegarderEtat();
      return;
    }

    const ancienneCommande = state.commandes[cmdIndex];

    // Parser le nouveau message
    const nouvellesLignes = parseCommandeMulti(newBody);

    if (!nouvellesLignes) {
      // Le nouveau message n'est plus une commande — on annule l'ancienne
      entreeHistorique.action = 'annulation';

      // Remettre le stock
      for (const ligne of ancienneCommande.lignes) {
        const vin = state.vins.find(v => v.lettre === ligne.lettre);
        if (vin) vin.stockRestant += ligne.qte;
      }

      state.commandes.splice(cmdIndex, 1);
      console.log('\u270f\ufe0f [EDIT] Commande annulée (nouveau message non reconnu)');
    } else {
      // Nouveau message = nouvelle commande — on remplace
      entreeHistorique.action = 'modification';

      // Remettre l'ancien stock
      for (const ligne of ancienneCommande.lignes) {
        const vin = state.vins.find(v => v.lettre === ligne.lettre);
        if (vin) vin.stockRestant += ligne.qte;
      }

      // Valider les nouvelles lignes
      const lignesValidees = [];
      let aEteModifie = false;
      let aEteRefuse = false;

      for (const { lettre, qte } of nouvellesLignes) {
        const vin = state.vins.find(v => v.lettre === lettre);
        if (!vin || vin.stockRestant <= 0) continue;

        if (vin.min && qte < vin.min) { aEteRefuse = true; continue; }

        let qteFinale = qte;
        let modifie = false;

        if (vin.max) {
          // Ne pas compter l'ancienne commande de ce client pour ce vin
          const dejaCommande = dejaCommandePar(numeroContact, lettre);
          const resteAutorise = vin.max - dejaCommande;
          if (resteAutorise <= 0) { aEteRefuse = true; continue; }
          if (qteFinale > resteAutorise) { qteFinale = resteAutorise; modifie = true; aEteModifie = true; }
        }

        qteFinale = Math.min(qteFinale, vin.stockRestant);
        lignesValidees.push({ lettre, qte: qteFinale, odooId: vin.odooId, modifie });
      }

      if (lignesValidees.length > 0) {
        // Décompter le nouveau stock
        for (const ligne of lignesValidees) {
          const vin = state.vins.find(v => v.lettre === ligne.lettre);
          if (vin) vin.stockRestant -= ligne.qte;
        }

        // Remplacer la commande
        state.commandes[cmdIndex] = {
          ...ancienneCommande,
          lignes: lignesValidees,
          msgOriginal: newBody,
          heure_edit: new Date().toLocaleTimeString('fr-BE'),
          edite: true
        };

        const reaction = (aEteModifie || aEteRefuse) ? '\ud83d\udc47' : '\ud83d\udc4d';
        console.log('\ud83d\udd07 [SILENCIEUX] Réaction edit : ' + reaction);
        entreeHistorique.lignesNouvelles = lignesValidees;
      } else if (aEteRefuse) {
        // Annulation car nouveau message invalide
        entreeHistorique.action = 'annulation_min';
        console.log('\u274c [EDIT] Nouveau message refusé — commande annulée');
      }
    }

    state.historique_edits = state.historique_edits || [];
    state.historique_edits.push(entreeHistorique);
    sauvegarderEtat();

    io.emit('update', state);
    console.log('\u270f\ufe0f [EDIT] Historique mis à jour | Restant : ' + stockTotalRestant());

    if (stockTotalRestant() === 0) {
      state.venteActive = false;
      sauvegarderEtat();
      io.emit('sold_out');
      console.log('\ud83d\udd07 [SILENCIEUX] SOLD OUT après modification');
    }
  });

  whatsappClient.initialize();
}

// ✅ Check automatique toutes les 5 minutes
setInterval(() => {
  if (!state.venteActive) return;
  const suspects = detecterDoublons();
  if (suspects.length > 0) {
    console.log('\n\u26a0\ufe0f [CHECK AUTO] ' + suspects.length + ' doublon(s) suspect(s) détecté(s) :');
    suspects.forEach(s => {
      console.log('   → ' + (s.nom || s.numero) + ' | "' + s.message + '" (lignes ' + s.indexA + ' et ' + s.indexB + ')');
      // Marquer automatiquement comme suspect
      if (state.commandes[s.indexA]) state.commandes[s.indexA].suspect = true;
      if (state.commandes[s.indexB]) state.commandes[s.indexB].suspect = true;
    });
    sauvegarderEtat();
    io.emit('update', state);
    io.emit('doublons_detectes', suspects);
  }
}, 5 * 60 * 1000); // toutes les 5 minutes

server.listen(PORT, () => {
  console.log('\u23f3 Démarrage Wine Cellar Multi-Vins [MODE SILENCIEUX]...');
  demarrerWhatsApp();
});
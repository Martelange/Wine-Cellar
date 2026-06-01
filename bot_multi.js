// ============================================================
//  WINE CELLAR – Bot WhatsApp Ventes Flash MULTI-VINS v5
//  WhatsApp complet + Intégration Odoo v19
// ============================================================

require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'moncode123';
const GROUPE_ID = process.env.GROUPE_ID || '';

const ODOO_URL = 'https://' + (process.env.ODOO_URL || '').replace(/^https?:\/\//, '');
const ODOO_DB = process.env.ODOO_DB || '';
const ODOO_API_KEY = process.env.ODOO_API_KEY || '';

const DATA_FILE = path.join(__dirname, 'vente_en_cours.json');
const CLIENTS_FILE = path.join(__dirname, 'clients_odoo.json');
const STICKER_FILE = path.join(__dirname, 'sticker_soldout.webp');
const DELAI_MERCI = 20000;

const TAGS_TYPE = { rouge: 'ROUGE', blanc: 'BLANC', rose: 'ROSE', orange: 'ORANGE', petillant: 'PETILLANT' };

// ---------- ODOO API ----------
const xmlrpc = require('xmlrpc');

let odooUid = null;
let odooDbCourant = null;

function createOdooClient(p) {
  const urlParsed = new URL(ODOO_URL);
  const options = {
    host: urlParsed.hostname,
    port: parseInt(urlParsed.port) || (urlParsed.protocol === 'https:' ? 443 : 80),
    path: p
  };
  return urlParsed.protocol === 'https:'
    ? xmlrpc.createSecureClient(options)
    : xmlrpc.createClient(options);
}

function xmlrpcMethodCall(client, method, params) {
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, val) => {
      if (err) reject(err);
      else resolve(val);
    });
  });
}

async function odooAuthenticate() {
  if (odooDbCourant !== ODOO_DB) { odooUid = null; odooDbCourant = ODOO_DB; }
  if (odooUid) return odooUid;
  const client = createOdooClient('/xmlrpc/2/common');
  const login = process.env.ODOO_LOGIN || 'admin';
  const uid = await xmlrpcMethodCall(client, 'authenticate', [ODOO_DB, login, ODOO_API_KEY, {}]);
  if (!uid || uid === false || uid === 0) throw new Error('Auth Odoo echouee');
  odooUid = uid;
  console.log('Odoo authentifie, uid:', odooUid);
  return odooUid;
}

async function odooExecute(model, method, args = [], kwargs = {}) {
  const uid = await odooAuthenticate();
  const client = createOdooClient('/xmlrpc/2/object');
  return await xmlrpcMethodCall(client, 'execute_kw', [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs]);
}

async function odooGetProduits(recherche = '') {
  try {
    const domain = [['active', '=', true], ['sale_ok', '=', true]];
    if (recherche && recherche.trim().length > 0) domain.push(['name', 'ilike', recherche.trim()]);
    const produits = await odooExecute('product.template', 'search_read', [domain], {
      fields: ['id', 'name', 'list_price', 'categ_id'], limit: 50, order: 'name asc'
    });
    return Array.isArray(produits) ? produits : [];
  } catch (e) { console.log('Erreur Odoo produits :', e.message); return []; }
}

async function odooGetClients(recherche = '') {
  try {
    const domain = [['active', '=', true]];
    if (recherche) domain.push('|', ['name', 'ilike', recherche], ['phone', 'ilike', recherche]);
    const clients = await odooExecute('res.partner', 'search_read', [domain], {
      fields: ['id', 'name', 'phone', 'email'], limit: 0, order: 'name asc'
    });
    return clients;
  } catch (e) { console.log('Erreur Odoo clients :', e.message); return []; }
}

function normaliserTel(tel) {
  if (!tel) return '';
  return tel.replace(/\D/g, '').replace(/^0/, '32');
}

async function construireCacheClients() {
  try {
    const clients = await odooGetClients();
    const cache = {};
    for (const c of clients) {
      const norm = normaliserTel(c.phone);
      if (norm) cache[norm] = { odoo_id: c.id, nom: c.name, email: c.email };
    }
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(cache, null, 2));
    console.log('Cache clients Odoo mis a jour : ' + clients.length + ' clients');
    return cache;
  } catch (e) {
    if (e.message.includes('TITLE')) console.log('Odoo indisponible — cache conserve');
    else console.log('Erreur cache clients :', e.message);
    return chargerClients();
  }
}

async function creerSalesOrder(clientOdooId, nomClient, lignes, vins) {
  try {
    const orderId = await odooExecute('sale.order', 'create', [{
      partner_id: clientOdooId,
      note: 'Commande Wine Cellar vente flash du ' + new Date().toLocaleDateString('fr-BE')
    }]);
    for (const ligne of lignes) {
      const vin = vins.find(v => v.lettre === ligne.lettre);
      if (!vin || !vin.odooId) continue;
      const variants = await odooExecute('product.product', 'search_read',
        [[['product_tmpl_id', '=', parseInt(vin.odooId)], ['active', '=', true]]],
        { fields: ['id'], limit: 1 });
      if (!variants || variants.length === 0) { console.log('Variante introuvable pour', vin.odooId); continue; }
      await odooExecute('sale.order.line', 'create', [{
        order_id: orderId, product_id: variants[0].id,
        product_uom_qty: ligne.qteTotal, price_unit: parseFloat(vin.prix) || 0
      }]);
    }
    return orderId;
  } catch (e) { console.log('Erreur SO pour ' + nomClient + ' :', e.message); return null; }
}

// ---------- CLIENTS LOCAUX ----------
function chargerClients() {
  if (fs.existsSync(CLIENTS_FILE)) {
    try { return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')); } catch { return {}; }
  }
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify({}, null, 2));
  return {};
}
let clientsOdoo = chargerClients();

// ---------- ETAT ----------
function etatInitial() {
  return {
    texteLibre: '', vins: [], commandes: [], commandes_attente: [], venteActive: false,
    dateVente: new Date().toISOString(), heureDebut: null,
    seuil50envoye: false, seuil20envoye: false, historique_edits: []
  };
}

function chargerEtat() {
  if (fs.existsSync(DATA_FILE)) {
    try { const etat = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); etat.venteActive = false; return etat; }
    catch { return etatInitial(); }
  }
  return etatInitial();
}

let state = chargerEtat();
function sauvegarderEtat() { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }

function formatDuree(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return sec + ' secondes';
  if (sec === 0) return min + ' minute' + (min > 1 ? 's' : '');
  return min + ' minute' + (min > 1 ? 's' : '') + ' et ' + sec + ' secondes';
}

function stockTotalRestant() { return state.vins.reduce((s, v) => s + v.stockRestant, 0); }
function stockTotalInitial() { return state.vins.reduce((s, v) => s + v.stock, 0); }

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

// ---------- ANTI-DOUBLON ----------
const messagesTraites = new Map();
function estDejaTraite(msgId) {
  if (messagesTraites.has(msgId)) return true;
  messagesTraites.set(msgId, Date.now());
  for (const [id, ts] of messagesTraites) { if (Date.now() - ts > 10000) messagesTraites.delete(id); }
  return false;
}

function detecterDoublons() {
  const suspects = [];
  for (let i = 0; i < state.commandes.length; i++) {
    for (let j = i + 1; j < state.commandes.length; j++) {
      const a = state.commandes[i], b = state.commandes[j];
      if (a.numero === b.numero && a.msgOriginal === b.msgOriginal)
        suspects.push({ indexA: i, indexB: j, numero: a.numero, nom: a.nom, message: a.msgOriginal });
    }
  }
  return suspects;
}

// ---------- PARSING ----------
const MOTS_IGNORES = /\b(stp|svp|aub|merci|please|et|en|s'il|vous|plait|si)\b/gi;
function parseCommandeMulti(msgBody) {
  const txt = msgBody.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(MOTS_IGNORES, ' ').replace(/[,;\/]/g, ' ').replace(/\s+/g, ' ').trim();
  const resultats = [];
  const pattern = /(\d+)\s*([a-z])\b|([a-z])\s*(\d+)\b/g;
  let match;
  while ((match = pattern.exec(txt)) !== null) {
    let qte, lettre;
    if (match[1] && match[2]) { qte = parseInt(match[1]); lettre = match[2].toUpperCase(); }
    else if (match[3] && match[4]) { qte = parseInt(match[4]); lettre = match[3].toUpperCase(); }
    if (qte && lettre && qte > 0 && qte <= 200)
      if (!resultats.find(r => r.lettre === lettre)) resultats.push({ lettre, qte });
  }
  return resultats.length > 0 ? resultats : null;
}

// ---------- NUMERO REEL ----------
async function getNumeroReel(msg) {
  const brut = msg.author || msg.from;
  if (brut.includes('@lid')) {
    try {
      const contact = await msg.getContact();
      if (contact.id && contact.id.user) return contact.id.user;
      if (contact.number) return contact.number;
    } catch (e) { return brut.replace(/@lid/g, ''); }
  }
  return brut.replace(/@c\.us|@g\.us/g, '').replace(/\D/g, '');
}

// ---------- REACTIONS ----------
function reagirAvecDelai(msg, emoji) {
  const delai = Math.floor(Math.random() * 2000) + 1000;
  setTimeout(async () => {
    try { await msg.react(emoji); }
    catch (e) { console.log('Reaction echouee :', e.message); }
  }, delai);
}

// ---------- MESSAGES WHATSAPP ----------
function construireMessageVente() {
  const CONT_SING = { bouteille: 'bouteille', magnum: 'magnum', jeroboam: 'jeroboam' };
  const CONT_PLUR = { bouteille: 'bouteilles', magnum: 'magnums', jeroboam: 'jeroboams' };
  const CONT_ABR  = { bouteille: 'btl.', magnum: 'mag.', jeroboam: 'jer.' };
  let msg = '';
  if (state.texteLibre) msg += state.texteLibre + '\n\n';
  msg += '\u2500'.repeat(30) + '\n';
  state.vins.forEach(vin => {
    const abrv = CONT_ABR[vin.contenant] || 'btl.';
    const plur = CONT_PLUR[vin.contenant] || 'bouteilles';
    const sing = CONT_SING[vin.contenant] || 'bouteille';
    const typeTag = vin.type ? (TAGS_TYPE[vin.type] || '') + ' - ' : '';
    msg += '\n*' + vin.lettre + '.* ' + typeTag + vin.nom + ' \u2014 ' + vin.prix + '\u20ac/' + abrv + '\n';
    msg += '   \ud83d\udce6 ' + vin.stock + ' ' + plur + ' disponibles\n';
    if (vin.max) msg += '   \u2b06\ufe0f Maximum ' + vin.max + ' ' + (vin.max > 1 ? plur : sing) + ' par personne\n';
    if (vin.min && vin.min > 1) msg += '   \u2b07\ufe0f Minimum ' + vin.min + ' ' + (vin.min > 1 ? plur : sing) + ' par commande\n';
  });
  msg += '\n' + '\u2500'.repeat(30) + '\n';
  msg += '\n\ud83d\udcdd *Comment commander ?*\n';
  msg += '   *Quantite + Lettre* pour chaque vin souhaite\n';
  msg += '   Ex: *3A* \u2014 *6B* \u2014 *2A 3B* \u2014 *6A 3B 2C*\n\n';
  msg += '\ud83d\udc4d All good \u2014 commande validee telle quelle\n';
  msg += '\ud83d\udc47 Commande modifiee (regles ou fin de stock)\n';
  msg += '\u274c Commande refusee\n';
  msg += '\ud83d\udce7 Facture envoyee par mail ulterieurement';
  return msg;
}

function construireMessageStocks() {
  const CONT_PLUR = { bouteille: 'bouteilles', magnum: 'magnums', jeroboam: 'jeroboams' };
  const duree = state.heureDebut ? formatDuree(Date.now() - state.heureDebut) : '?';
  let msg = '\ud83d\udcca *Etat des stocks* \u2014 ' + duree + ' apres le lancement\n';
  msg += '\u2500'.repeat(30) + '\n\n';
  state.vins.forEach(vin => {
    const plur = CONT_PLUR[vin.contenant] || 'bouteilles';
    const pct = vin.stock > 0 ? Math.round((vin.stockRestant / vin.stock) * 100) : 0;
    const vendues = vin.stock - vin.stockRestant;
    const emoji = pct <= 20 ? '\ud83d\udd34' : pct <= 50 ? '\ud83d\udfe1' : '\ud83d\udfe2';
    if (vin.stockRestant === 0) {
      msg += emoji + ' *' + vin.lettre + '.* ' + vin.nom + '\n';
      msg += '   \ud83d\udd34 SOLD OUT (' + vendues + ' ' + plur + ' vendus)\n\n';
    } else {
      msg += emoji + ' *' + vin.lettre + '.* ' + vin.nom + '\n';
      msg += '   ' + vin.stockRestant + ' ' + plur + ' restants \u2014 *' + pct + '%* disponible\n\n';
    }
  });
  const totalRestant = stockTotalRestant();
  const totalInitial = stockTotalInitial();
  const totalPct = totalInitial > 0 ? Math.round((totalRestant / totalInitial) * 100) : 0;
  msg += '\u2500'.repeat(30) + '\n';
  msg += '\ud83c\udf77 *Total : ' + totalRestant + ' bouteilles restantes (' + totalPct + '%)*';
  return msg;
}

// ---------- SEUILS ----------
async function verifierSeuils() {
  const restant = stockTotalRestant();
  const total = stockTotalInitial();
  if (total === 0) return;
  const pct = (restant / total) * 100;
  const duree = state.heureDebut ? formatDuree(Date.now() - state.heureDebut) : '?';
  const vendues = total - restant;
  if (!state.seuil50envoye && pct <= 50) {
    state.seuil50envoye = true; sauvegarderEtat();
    const msg = '\ud83d\udfe1 *Mi-parcours !*\n\n*' + vendues + ' bouteilles* vendues en ' + duree + ' !\nIl reste encore *' + restant + ' bouteilles* disponibles.\n\nDepêchez-vous... \u23f0';
    try { await whatsappClient.sendMessage(GROUPE_ID, msg); } catch (e) { console.log('Erreur 50% :', e.message); }
  }
  if (!state.seuil20envoye && pct <= 20) {
    state.seuil20envoye = true; sauvegarderEtat();
    const msg = '\ud83d\udd34 *Plus que ' + restant + ' bouteilles !*\n\nOn a ecoule *' + vendues + ' bouteilles* en ' + duree + '...\nC\'est le moment ou jamais ! \ud83c\udf77';
    try { await whatsappClient.sendMessage(GROUPE_ID, msg); } catch (e) { console.log('Erreur 20% :', e.message); }
  }
}

// ---------- SOLD OUT ----------
async function sequenceSoldOut() {
  const duree = state.heureDebut ? formatDuree(Date.now() - state.heureDebut) : '?';
  const vendues = stockTotalInitial();
  const nbCommandes = state.commandes.length;
  console.log('\nSOLD OUT !');
  if (fs.existsSync(STICKER_FILE)) {
    try { const media = MessageMedia.fromFilePath(STICKER_FILE); await whatsappClient.sendMessage(GROUPE_ID, media, { sendMediaAsSticker: true }); }
    catch (e) { await whatsappClient.sendMessage(GROUPE_ID, '\ud83d\udd34 *SOLD OUT !*'); }
  } else { await whatsappClient.sendMessage(GROUPE_ID, '\ud83d\udd34 *SOLD OUT !*'); }
  setTimeout(async () => {
    const fin = '\ud83d\udd25 *SOLD OUT en ' + duree + '* \u26a1\n\n*Un enorme merci a tous* \ud83d\ude4f\nVous avez ete ultra rapides !\n\n\ud83d\udce6 *' + vendues + ' bouteilles* vendues\n\ud83d\udc65 *' + nbCommandes + ' commandes* enregistrees\n\nVous serez contactes prochainement. \ud83c\udf77';
    try { await whatsappClient.sendMessage(GROUPE_ID, fin); } catch (e) { console.log('Erreur fin :', e.message); }
  }, DELAI_MERCI);
}

// ---------- PROGRAMMATION VENTE COTE SERVEUR ----------
let timerProgrammation = null;
let programmationHeure = null;
let programmationData = null;

function annulerProgrammationServeur() {
  if (timerProgrammation) { clearTimeout(timerProgrammation); timerProgrammation = null; }
  programmationHeure = null;
  programmationData = null;
  io.emit('programmation_status', null);
}

function programmerVenteServeur(heureISO, texteLibre, vins) {
  annulerProgrammationServeur();
  const cible = new Date(heureISO);
  const delaiMs = cible - Date.now();
  if (delaiMs <= 0) return { error: 'Heure déjà passée' };

  programmationHeure = heureISO;
  programmationData = { texteLibre, vins };
  io.emit('programmation_status', { heureISO });

  timerProgrammation = setTimeout(async () => {
    timerProgrammation = null;
    programmationHeure = null;
    programmationData = null;
    io.emit('programmation_status', null);

    const vinsAvecLettres = vins.map((vin, i) => ({
      lettre: String.fromCharCode(65 + i),
      nom: vin.nom || '', prix: vin.prix || '', type: vin.type || '',
      contenant: vin.contenant || 'bouteille',
      stock: parseInt(vin.stock) || 0, stockRestant: parseInt(vin.stock) || 0,
      min: parseInt(vin.min) || 1, max: parseInt(vin.max) || null, odooId: vin.odooId || null
    }));

    state = etatInitial();
    state.texteLibre = texteLibre || '';
    state.vins = vinsAvecLettres;
    state.venteActive = true;
    state.dateVente = new Date().toISOString();
    state.heureDebut = Date.now();
    sauvegarderEtat();
    io.emit('update', state);

    try {
      await whatsappClient.sendMessage(GROUPE_ID, construireMessageVente());
      console.log('\nVente programmee lancee : ' + vinsAvecLettres.length + ' vins');
      io.emit('vente_lancee_auto');
    } catch (e) { console.log('Erreur envoi vente programmee :', e.message); }
  }, delaiMs);

  console.log('Vente programmee a ' + cible.toLocaleTimeString('fr-BE') + ' (dans ' + Math.round(delaiMs / 60000) + ' min)');
  return { ok: true, heureISO };
}

// ---------- TRAITEMENT COMMANDE ----------
async function traiterCommande(msg, body, numeroContact, nom, estDuGroupe) {
  const lignesParsees = parseCommandeMulti(body);
  if (!lignesParsees) return;

  const msgId = (msg.id && msg.id._serialized) ? msg.id._serialized : (numeroContact + '|' + body);
  if (estDejaTraite(msgId)) { console.log('Doublon ignore :', msgId.slice(0, 40)); return; }

  const lignesValidees = [];
  let aEteModifie = false;
  let aEteRefuse = false;

  for (const { lettre, qte } of lignesParsees) {
    const qteOriginale = qte;
    const vin = state.vins.find(v => v.lettre === lettre);
    if (!vin) continue;
    if (vin.stockRestant <= 0) { aEteRefuse = true; continue; }
    if (vin.min && qte < vin.min) { aEteRefuse = true; continue; }

    let qteFinale = qte;
    let modifie = false;
    if (vin.max) {
      const dejaCommande = dejaCommandePar(numeroContact, lettre);
      const resteAutorise = vin.max - dejaCommande;
      if (resteAutorise <= 0) { aEteRefuse = true; continue; }
      if (qteFinale > resteAutorise) { qteFinale = resteAutorise; modifie = true; aEteModifie = true; }
    }
    if (qteFinale > vin.stockRestant) { qteFinale = vin.stockRestant; aEteModifie = true; modifie = true; }
    lignesValidees.push({ lettre, qte: qteFinale, odooId: vin.odooId, modifie: modifie || qteFinale < qteOriginale });
  }

  if (lignesValidees.length > 0) {
    reagirAvecDelai(msg, (aEteModifie || aEteRefuse) ? '\ud83d\udc47' : '\ud83d\udc4d');
  } else {
    reagirAvecDelai(msg, '\u274c');
    const lignesAttente = [];
    for (const { lettre, qte } of lignesParsees) {
      const vin = state.vins.find(v => v.lettre === lettre);
      if (!vin) continue;
      lignesAttente.push({ lettre, qte, odooId: vin.odooId });
    }
    if (lignesAttente.length > 0) {
      const clientOdoo = clientsOdoo[numeroContact] || {};
      state.commandes_attente = state.commandes_attente || [];
      state.commandes_attente.push({
        heure: new Date().toLocaleTimeString('fr-BE'), numero: numeroContact,
        nom: clientOdoo.nom || nom, odoo_client_id: clientOdoo.odoo_id || null,
        lignes: lignesAttente, source: estDuGroupe ? 'groupe' : 'prive',
        msgOriginal: body, en_attente: true
      });
      sauvegarderEtat();
      io.emit('update', state);
      console.log('[ATTENTE] ' + (clientOdoo.nom || nom || numeroContact) + ' -> ' + lignesAttente.map(l => l.lettre + ':' + l.qte).join(' | '));
    }
    return;
  }

  for (const ligne of lignesValidees) {
    const vin = state.vins.find(v => v.lettre === ligne.lettre);
    if (vin) vin.stockRestant -= ligne.qte;
  }

  for (const ligne of lignesValidees) {
    const vin = state.vins.find(v => v.lettre === ligne.lettre);
    if (vin && vin.stockRestant === 0) {
      const msgSoldOut = '\ud83d\udd34 *' + vin.lettre + '. ' + vin.nom + ' \u2014 SOLD OUT !*\n\nToutes les bouteilles ont trouv\u00e9 preneur. Merci ! \ud83c\udf77';
      try { await whatsappClient.sendMessage(GROUPE_ID, msgSoldOut); }
      catch (e) { console.log('Erreur sold out vin :', e.message); }
    }
  }

  const clientOdoo = clientsOdoo[numeroContact] || {};
  const commande = {
    heure: new Date().toLocaleTimeString('fr-BE'),
    numero: numeroContact, nom: clientOdoo.nom || nom,
    odoo_client_id: clientOdoo.odoo_id || null,
    lignes: lignesValidees, source: estDuGroupe ? 'groupe' : 'prive', msgOriginal: body
  };
  state.commandes.push(commande);
  sauvegarderEtat();
  io.emit('update', state);
  io.emit('nouvelle_commande', commande);
  const resume = lignesValidees.map(l => l.lettre + ':' + l.qte + (l.modifie ? '(max)' : '')).join(' | ');
  console.log('[' + commande.heure + '] ' + (commande.nom || numeroContact) + ' -> ' + resume + ' | Restant : ' + stockTotalRestant());
  await verifierSeuils();
}

// ---------- EXPRESS ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

let dernierQrCode = null;
io.on('connection', socket => {
  if (dernierQrCode) socket.emit('qr_code', dernierQrCode);
  socket.emit('update', state);
  if (programmationHeure) socket.emit('programmation_status', { heureISO: programmationHeure });
});

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

app.get('/api/odoo/produits', requireAuth, async (req, res) => {
  res.json(await odooGetProduits(req.query.q || ''));
});

app.get('/api/odoo/clients', requireAuth, async (req, res) => {
  res.json(await odooGetClients(req.query.q || ''));
});

app.post('/api/odoo/sync-clients', requireAuth, async (req, res) => {
  clientsOdoo = await construireCacheClients();
  io.emit('clients_synced', Object.keys(clientsOdoo).length);
  res.json({ ok: true, count: Object.keys(clientsOdoo).length });
});

app.post('/api/odoo/creer-orders', requireAuth, async (req, res) => {
  if (state.commandes.length === 0) return res.status(400).json({ error: 'Aucune commande' });
  const map = {};
  for (const cmd of state.commandes) {
    if (!map[cmd.numero]) map[cmd.numero] = { ...cmd, lignesConsolid: {} };
    for (const ligne of cmd.lignes) {
      if (!map[cmd.numero].lignesConsolid[ligne.lettre])
        map[cmd.numero].lignesConsolid[ligne.lettre] = { lettre: ligne.lettre, qteTotal: 0 };
      map[cmd.numero].lignesConsolid[ligne.lettre].qteTotal += ligne.qte;
    }
  }
  const resultats = [];
  for (const [numero, client] of Object.entries(map)) {
    const clientOdoo = clientsOdoo[numero] || {};
    let odooIdFinal = client.odoo_client_id || clientOdoo.odoo_id;
    if (!odooIdFinal) {
      try {
        const newPartnerId = await odooExecute('res.partner', 'create', [{
          name: client.nom || ('WA +' + numero), phone: '+' + numero, customer_rank: 1
        }]);
        odooIdFinal = newPartnerId;
        clientsOdoo[numero] = { odoo_id: newPartnerId, nom: client.nom || ('WA +' + numero), email: null };
        fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clientsOdoo, null, 2));
        console.log('Nouveau client cree : #' + newPartnerId);
        const msgPrive = 'Bonjour,\n\nMerci beaucoup pour cette premi\u00e8re commande sur Wine Cellar ! \ud83c\udf77\n\nPuis-je vous demander votre adresse mail ?\nAvez-vous besoin d\'une facture ? Si oui, je veux bien les coordonn\u00e9es.\n\nMerci d\'avance\nBon week-end\n\nHugues / Wine Cellar';
        try { await whatsappClient.sendMessage(numero + '@c.us', msgPrive); } catch (e) { console.log('Erreur msg prive :', e.message); }
      } catch (e) {
        resultats.push({ numero, nom: client.nom, status: 'erreur', message: e.message });
        continue;
      }
    }
    const lignes = Object.values(client.lignesConsolid);
    const orderId = await creerSalesOrder(odooIdFinal, client.nom, lignes, state.vins);
    if (orderId) { resultats.push({ numero, nom: client.nom, status: 'ok', orderId }); console.log('SO cree pour ' + client.nom + ' : SO#' + orderId); }
    else resultats.push({ numero, nom: client.nom, status: 'erreur', message: 'Erreur creation SO' });
  }
  res.json({ ok: true, resultats });
});

app.post('/api/clients', requireAuth, (req, res) => {
  const { numero, odoo_id, nom } = req.body;
  if (!numero || !odoo_id) return res.status(400).json({ error: 'Invalide' });
  clientsOdoo[numero.replace(/\D/g, '')] = { odoo_id: parseInt(odoo_id), nom: nom || '' };
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clientsOdoo, null, 2));
  res.json({ ok: true });
});

app.delete('/api/clients/:numero', requireAuth, (req, res) => {
  delete clientsOdoo[req.params.numero.replace(/\D/g, '')];
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clientsOdoo, null, 2));
  res.json({ ok: true });
});

app.post('/api/nouvelle-vente', requireAuth, async (req, res) => {
  const { texteLibre, vins } = req.body;
  if (!vins || vins.length === 0) return res.status(400).json({ error: 'Aucun vin defini' });
  const vinsAvecLettres = vins.map((vin, i) => ({
    lettre: String.fromCharCode(65 + i),
    nom: vin.nom || '', prix: vin.prix || '', type: vin.type || '',
    contenant: vin.contenant || 'bouteille',
    stock: parseInt(vin.stock) || 0, stockRestant: parseInt(vin.stock) || 0,
    min: parseInt(vin.min) || 1, max: parseInt(vin.max) || null, odooId: vin.odooId || null
  }));
  state = etatInitial();
  state.texteLibre = texteLibre || '';
  state.vins = vinsAvecLettres;
  state.venteActive = true;
  state.dateVente = new Date().toISOString();
  state.heureDebut = Date.now();
  sauvegarderEtat();
  io.emit('update', state);
  try {
    await whatsappClient.sendMessage(GROUPE_ID, construireMessageVente());
    console.log('\nVente demarree : ' + vinsAvecLettres.length + ' vins');
    res.json({ ok: true });
  } catch (e) {
    console.log('Erreur envoi :', e.message);
    res.json({ ok: true, warning: 'Vente demarree mais message non envoye' });
  }
});

app.post('/api/programmer-vente', requireAuth, (req, res) => {
  const { heureISO, texteLibre, vins } = req.body;
  if (!heureISO || !vins || vins.length === 0) return res.status(400).json({ error: 'Invalide' });
  const result = programmerVenteServeur(heureISO, texteLibre, vins);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/annuler-programmation', requireAuth, (req, res) => {
  annulerProgrammationServeur();
  res.json({ ok: true });
});

app.get('/api/programmation', requireAuth, (req, res) => {
  res.json(programmationHeure ? { heureISO: programmationHeure } : null);
});

app.post('/api/stopper', requireAuth, (req, res) => {
  state.venteActive = false;
  sauvegarderEtat();
  io.emit('update', state);
  res.json({ ok: true });
});

app.post('/api/envoyer-stocks', requireAuth, async (req, res) => {
  if (state.vins.length === 0) return res.status(400).json({ error: 'Aucune vente en cours' });
  try { await whatsappClient.sendMessage(GROUPE_ID, construireMessageStocks()); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/historique-edits', requireAuth, (req, res) => res.json(state.historique_edits || []));
app.get('/api/doublons', requireAuth, (req, res) => res.json(detecterDoublons()));

app.get('/api/commandes-attente', requireAuth, (req, res) => res.json(state.commandes_attente || []));

app.post('/api/commande-attente/:index/valider', requireAuth, (req, res) => {
  const idx = parseInt(req.params.index);
  const attente = state.commandes_attente || [];
  if (isNaN(idx) || idx < 0 || idx >= attente.length) return res.status(400).json({ error: 'Index invalide' });
  const cmd = { ...attente[idx], en_attente: false, valide_manuellement: true };
  state.commandes.push(cmd);
  state.commandes_attente.splice(idx, 1);
  sauvegarderEtat(); io.emit('update', state); io.emit('nouvelle_commande', cmd);
  res.json({ ok: true });
});

app.delete('/api/commande-attente/:index', requireAuth, (req, res) => {
  const idx = parseInt(req.params.index);
  const attente = state.commandes_attente || [];
  if (isNaN(idx) || idx < 0 || idx >= attente.length) return res.status(400).json({ error: 'Index invalide' });
  state.commandes_attente.splice(idx, 1);
  sauvegarderEtat(); io.emit('update', state);
  res.json({ ok: true });
});

app.patch('/api/commande/:index/modifier', requireAuth, (req, res) => {
  const idx = parseInt(req.params.index);
  if (isNaN(idx) || idx < 0 || idx >= state.commandes.length) return res.status(400).json({ error: 'Index invalide' });
  const { lignes } = req.body;
  if (!lignes || lignes.length === 0) return res.status(400).json({ error: 'Lignes invalides' });
  const anciennesLignes = state.commandes[idx].lignes;
  for (const ligne of anciennesLignes) {
    const vin = state.vins.find(v => v.lettre === ligne.lettre);
    if (vin) vin.stockRestant += ligne.qte;
  }
  const nouvellesLignes = [];
  for (const { lettre, qte } of lignes) {
    const vin = state.vins.find(v => v.lettre === lettre);
    if (!vin || qte <= 0) continue;
    const qteFin = Math.min(parseInt(qte), vin.stockRestant);
    if (qteFin <= 0) continue;
    vin.stockRestant -= qteFin;
    nouvellesLignes.push({ ...anciennesLignes.find(l => l.lettre === lettre) || {}, lettre, qte: qteFin });
  }
  state.commandes[idx].lignes = nouvellesLignes;
  state.commandes[idx].modifie_manuellement = true;
  sauvegarderEtat(); io.emit('update', state);
  res.json({ ok: true });
});

app.post('/api/commande-manuelle', requireAuth, (req, res) => {
  const { numero, nom, lignes, odoo_client_id } = req.body;
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
    heure: new Date().toLocaleTimeString('fr-BE'),
    numero: numero.replace(/\D/g, ''), nom: nom || '',
    odoo_client_id: odoo_client_id || null,
    lignes: lignesValidees, source: 'manuel', msgOriginal: '[Ajout manuel]', manuel: true
  };
  state.commandes.push(commande);
  sauvegarderEtat(); io.emit('update', state); io.emit('nouvelle_commande', commande);
  res.json({ ok: true });
});

app.delete('/api/commande/:index', requireAuth, (req, res) => {
  const idx = parseInt(req.params.index);
  if (isNaN(idx) || idx < 0 || idx >= state.commandes.length) return res.status(400).json({ error: 'Index invalide' });
  const commande = state.commandes[idx];
  for (const ligne of commande.lignes) {
    const vin = state.vins.find(v => v.lettre === ligne.lettre);
    if (vin) vin.stockRestant += ligne.qte;
  }
  state.commandes.splice(idx, 1);
  sauvegarderEtat(); io.emit('update', state);
  res.json({ ok: true });
});

app.patch('/api/commande/:index/suspect', requireAuth, (req, res) => {
  const idx = parseInt(req.params.index);
  if (isNaN(idx) || idx < 0 || idx >= state.commandes.length) return res.status(400).json({ error: 'Index invalide' });
  state.commandes[idx].suspect = !state.commandes[idx].suspect;
  sauvegarderEtat(); io.emit('update', state);
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
          odooClientId: cmd.odoo_client_id || cl.odoo_id || '',
          telephone: '+' + cmd.numero, nom: cl.nom || cmd.nom || '',
          lettre: ligne.lettre, type: vin ? (vin.type || '') : '',
          vinNom: vin ? vin.nom : '', odooProduittId: vin ? (vin.odooId || '') : '',
          qteTotal: 0, prix: vin ? vin.prix : '', contenant: vin ? vin.contenant : '',
          date: state.dateVente.slice(0, 10)
        };
      }
      map[key].qteTotal += ligne.qte;
    }
  }
  const lignes = Object.values(map).sort((a, b) => {
    const n = (a.nom || a.telephone).localeCompare(b.nom || b.telephone);
    return n !== 0 ? n : a.lettre.localeCompare(b.lettre);
  });
  const headers = 'Odoo_Client_ID,Telephone,Nom,Lettre,Type,Vin,Odoo_Produit_ID,Quantite_Totale,Prix_Unit,Contenant,Date';
  const csv = '\uFEFF' + headers + '\r\n' + lignes.map(l =>
    [l.odooClientId, l.telephone, l.nom, l.lettre, l.type, l.vinNom,
     l.odooProduittId, l.qteTotal, l.prix, l.contenant, l.date]
    .map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')
  ).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="vente_' + state.dateVente.slice(0, 10) + '.csv"');
  res.send(csv);
});

setInterval(() => {
  if (!state.venteActive) return;
  const suspects = detecterDoublons();
  if (suspects.length > 0) {
    suspects.forEach(s => {
      if (state.commandes[s.indexA]) state.commandes[s.indexA].suspect = true;
      if (state.commandes[s.indexB]) state.commandes[s.indexB].suspect = true;
    });
    sauvegarderEtat(); io.emit('update', state); io.emit('doublons_detectes', suspects);
  }
}, 5 * 60 * 1000);

// ---------- WHATSAPP ----------
let whatsappClient;

function demarrerWhatsApp() {
  if (!GROUPE_ID) console.log('GROUPE_ID non defini dans le .env !');

  whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  whatsappClient.on('qr', qr => {
    console.log('QR Code recu, disponible sur le dashboard');
    dernierQrCode = qr;
    io.emit('qr_needed');
    io.emit('qr_code', qr);
  });

  whatsappClient.on('ready', async () => {
    dernierQrCode = null;
    console.log('\nBot connecte ! Numero :', whatsappClient.info.wid.user);
    console.log('Dashboard : http://localhost:' + PORT + '\n');
    io.emit('whatsapp_ready');
    if (ODOO_API_KEY) {
      console.log('Sync clients Odoo...');
      clientsOdoo = await construireCacheClients();
    }
  });

  whatsappClient.on('message', async msg => {
    if (msg.fromMe) return;
    // console.log('MSG DE :', msg.from, '|', msg.body.slice(0, 50));

    if (msg.type === 'sticker' && msg.hasMedia && !fs.existsSync(STICKER_FILE)) {
      try {
        const media = await msg.downloadMedia();
        fs.writeFileSync(STICKER_FILE, Buffer.from(media.data, 'base64'));
        console.log('Sticker capture !');
      } catch (e) { console.log('Sticker :', e.message); }
      return;
    }

    if (!state.venteActive) return;
    const estDuGroupe = msg.from === GROUPE_ID;
    const estMessagePrive = !msg.from.includes('@g.us');
    if (!estDuGroupe && !estMessagePrive) return;

    const numeroContact = await getNumeroReel(msg);
    const nom = (msg._data && msg._data.notifyName) || (clientsOdoo[numeroContact] && clientsOdoo[numeroContact].nom) || '';

    await traiterCommande(msg, msg.body, numeroContact, nom, estDuGroupe);

    if (stockTotalRestant() === 0) {
      state.venteActive = false; sauvegarderEtat();
      io.emit('sold_out'); await sequenceSoldOut();
    }
  });

  whatsappClient.on('message_edit', async (msg, newBody, oldBody) => {
    if (msg.fromMe) return;
    if (!state.venteActive) { console.log('Edit ignore'); return; }

    const estDuGroupe = msg.from === GROUPE_ID;
    const estMessagePrive = !msg.from.includes('@g.us');
    if (!estDuGroupe && !estMessagePrive) return;

    const numeroContact = await getNumeroReel(msg);
    const nom = (msg._data && msg._data.notifyName) || (clientsOdoo[numeroContact] && clientsOdoo[numeroContact].nom) || '';
    console.log('EDIT ' + (nom || numeroContact) + ' | "' + oldBody + '" -> "' + newBody + '"');

    const cmdIndex = state.commandes.findIndex(c => c.numero === numeroContact && c.msgOriginal === oldBody);
    const entreeHistorique = { heure: new Date().toLocaleTimeString('fr-BE'), numero: numeroContact, nom, ancienMessage: oldBody, nouveauMessage: newBody, action: '' };

    if (cmdIndex === -1) {
      const nouvellesLignes = parseCommandeMulti(newBody);
      if (nouvellesLignes) {
        entreeHistorique.action = 'nouveau_depuis_edit';
        const msgId = (msg.id && msg.id._serialized) ? msg.id._serialized : (numeroContact + '|' + oldBody);
        messagesTraites.delete(msgId);
        await traiterCommande(msg, newBody, numeroContact, nom, estDuGroupe);
      } else { entreeHistorique.action = 'ignore'; }
    } else {
      const ancienneCommande = state.commandes[cmdIndex];
      for (const ligne of ancienneCommande.lignes) {
        const vin = state.vins.find(v => v.lettre === ligne.lettre);
        if (vin) vin.stockRestant += ligne.qte;
      }
      const nouvellesLignes = parseCommandeMulti(newBody);
      if (!nouvellesLignes) {
        state.commandes.splice(cmdIndex, 1);
        entreeHistorique.action = 'annulation';
        reagirAvecDelai(msg, '\u274c');
      } else {
        const lignesValidees = [];
        let aEteModifie = false, aEteRefuse = false;
        for (const { lettre, qte } of nouvellesLignes) {
          const qteOriginale = qte;
          const vin = state.vins.find(v => v.lettre === lettre);
          if (!vin) continue;
          if (vin.stockRestant <= 0) { aEteRefuse = true; continue; }
          if (vin.min && qte < vin.min) { aEteRefuse = true; continue; }
          let qteFinale = qte, modifie = false;
          if (vin.max) {
            const dejaCommande = dejaCommandePar(numeroContact, lettre);
            const resteAutorise = vin.max - dejaCommande;
            if (resteAutorise <= 0) { aEteRefuse = true; continue; }
            if (qteFinale > resteAutorise) { qteFinale = resteAutorise; modifie = true; aEteModifie = true; }
          }
          if (qteFinale > vin.stockRestant) { qteFinale = vin.stockRestant; aEteModifie = true; modifie = true; }
          lignesValidees.push({ lettre, qte: qteFinale, odooId: vin.odooId, modifie: modifie || qteFinale < qteOriginale });
        }
        if (lignesValidees.length > 0) {
          for (const ligne of lignesValidees) {
            const vin = state.vins.find(v => v.lettre === ligne.lettre);
            if (vin) vin.stockRestant -= ligne.qte;
          }
          state.commandes[cmdIndex] = { ...ancienneCommande, lignes: lignesValidees, msgOriginal: newBody, edite: true };
          reagirAvecDelai(msg, (aEteModifie || aEteRefuse) ? '\ud83d\udc47' : '\ud83d\udc4d');
          entreeHistorique.action = 'modification';
        } else {
          state.commandes.splice(cmdIndex, 1);
          reagirAvecDelai(msg, '\u274c');
          entreeHistorique.action = 'annulation_min';
        }
      }
    }

    state.historique_edits = state.historique_edits || [];
    state.historique_edits.push(entreeHistorique);
    sauvegarderEtat(); io.emit('update', state);

    if (stockTotalRestant() === 0) {
      state.venteActive = false; sauvegarderEtat();
      io.emit('sold_out'); await sequenceSoldOut();
    }
  });

  whatsappClient.on('disconnected', () => {
    console.log('WhatsApp deconnecte.');
    io.emit('whatsapp_disconnected');
  });

  whatsappClient.initialize();
}

server.listen(PORT, () => {
  console.log('Demarrage Wine Cellar Multi-Vins v5...');
  demarrerWhatsApp();
});
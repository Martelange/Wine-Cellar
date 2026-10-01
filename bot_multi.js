// ============================================================
//  WINE CELLAR – Bot WhatsApp Ventes Flash MULTI-VINS v5
//  WhatsApp complet + Intégration Odoo v19
// ============================================================

require('dotenv').config();

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { parseCommandeMulti, estMessageCorrection } = require('./parsing');
const { validerLignes } = require('./regles');
const { numeroDepuisJid, numeroAuteur, correspondanceLid, extraireEdition, extraireCitation } = require('./whatsapp-msg');
const { analyserMessageIA, iaActivee, IA_MAX_APPELS_PAR_VENTE } = require('./ia');

// Le serveur Railway tourne en UTC : toujours formater les heures en heure belge
const FUSEAU = 'Europe/Brussels';
function heureBE() { return new Date().toLocaleTimeString('fr-BE', { timeZone: FUSEAU }); }

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'moncode123';
const GROUPE_ID = process.env.GROUPE_ID || '';  // rétrocompatibilité

// ---------- GROUPES CONFIGURABLES ----------
// Test en premier : c'est le groupe par defaut tant que rien n'est explicitement
// choisi dans le dashboard. Securite : ne jamais partir sur le groupe clients par
// accident (ex. apres un redeploiement qui repart d'un etat neuf).
const GROUPES_DISPONIBLES = [
  { id: process.env.GROUPE_TEST      || '', label: 'Test' },
  { id: process.env.GROUPE_PRINCIPAL || '', label: 'Principal' },
].filter(g => g.id.trim() !== '');

// Groupe vise quand aucune selection n'est enregistree. On prefere explicitement
// le groupe de test ; GROUPE_ID (retrocompat) n'est plus qu'un dernier recours.
function groupeParDefaut() {
  return process.env.GROUPE_TEST
      || process.env.GROUPE_PRINCIPAL
      || GROUPE_ID
      || (GROUPES_DISPONIBLES[0] && GROUPES_DISPONIBLES[0].id)
      || '';
}
function groupeActif() {
  return state.groupeActifId || groupeParDefaut();
}

const ODOO_URL = 'https://' + (process.env.ODOO_URL || '').replace(/^https?:\/\//, '');
const ODOO_DB = process.env.ODOO_DB || '';
const ODOO_API_KEY = process.env.ODOO_API_KEY || '';

// Dossier de session WhatsApp (nom historique conserve, monte sur le volume Railway persistant)
const AUTH_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '.wwebjs_auth');
// Etat des ventes + caches : sous-dossier dedie du volume, pour survivre aux redeploiements.
// (Corrige le 10/09/2026 : c'etait ecrit dans /app, efface a chaque redeploiement -> le choix
//  de groupe etait perdu et le bot repartait sur GROUPE_ID = Principal.)
let STATE_DIR = path.join(AUTH_DIR, 'wc_state');
try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
} catch (e) {
  console.log('STATE_DIR sur volume impossible (' + (e && e.message) + '), repli local');
  STATE_DIR = __dirname;
}
const DATA_FILE = path.join(STATE_DIR, 'vente_en_cours.json');
const CLIENTS_FILE = path.join(STATE_DIR, 'clients_odoo.json');
const STICKER_FILE = path.join(STATE_DIR, 'sticker_soldout.webp');
const DELAI_MERCI = 20000;

const TAGS_TYPE = { rouge: 'ROUGE', blanc: 'BLANC', rose: 'ROSE', orange: 'ORANGE', petillant: 'PETILLANT' };

// Wording par contenant (annonce, stocks, sold out par reference)
// abr = abreviation prix, stockPlur = mot du stock, qteSing/qtePlur = mots des min/max,
// restant/vendu = adjectifs du message stocks
const CONTENANTS_TXT = {
  bouteille: { abr: 'btl.', stockPlur: 'bouteilles', qteSing: 'bouteille', qtePlur: 'bouteilles', restant: 'restants', vendu: 'vendus', tous: 'Toutes les' },
  magnum:    { abr: 'mag.', stockPlur: 'magnums',    qteSing: 'magnum',    qtePlur: 'magnums',    restant: 'restants', vendu: 'vendus', tous: 'Tous les' },
  jeroboam:  { abr: 'jer.', stockPlur: 'jeroboams',  qteSing: 'jeroboam',  qtePlur: 'jeroboams',  restant: 'restants', vendu: 'vendus', tous: 'Tous les' },
  unite:     { abr: 'pce',  stockPlur: 'unit\u00e9s', qteSing: 'pi\u00e8ce', qtePlur: 'pi\u00e8ces', restant: 'restantes', vendu: 'vendues', tous: 'Toutes les' }
};
function motsContenant(contenant) { return CONTENANTS_TXT[contenant] || CONTENANTS_TXT.bouteille; }

// Texte de fin par defaut du message d'annonce (personnalisable depuis le dashboard)
const TEXTE_FIN_DEFAUT =
  '\ud83d\udcdd *Comment commander ?*\n' +
  '   *Quantite + Lettre* pour chaque vin souhaite\n' +
  '   Ex: *3A* \u2014 *6B* \u2014 *2A 3B* \u2014 *6A 3B 2C*\n\n' +
  '\ud83d\udc4d All good \u2014 commande validee telle quelle\n' +
  '\ud83d\udc47 Commande modifiee (regles ou fin de stock)\n' +
  '\u274c Commande refusee\n' +
  '\ud83d\udce7 Facture envoyee par mail ulterieurement';

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
  // "0032 472..." -> "32472..." ; "0472..." -> "32472..."
  return tel.replace(/\D/g, '').replace(/^00/, '').replace(/^0/, '32');
}

async function construireCacheClients() {
  try {
    const clients = await odooGetClients();
    const cache = {};
    let ignorees = 0;
    for (const c of clients) {
      const norm = normaliserTel(c.phone);
      // fiche creee jadis avec un identifiant anonyme WhatsApp en guise de telephone
      if (norm && estIdentifiantAnonyme(norm)) { ignorees++; continue; }
      if (norm) cache[norm] = { odoo_id: c.id, nom: c.name, email: c.email };
    }
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(cache, null, 2));
    console.log('Cache clients Odoo mis a jour : ' + clients.length + ' clients' + (ignorees ? ' (' + ignorees + ' fiche(s) a identifiant anonyme ignoree(s))' : ''));
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
      note: 'Commande Wine Cellar vente flash du ' + new Date().toLocaleDateString('fr-BE', { timeZone: FUSEAU })
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
    texteLibre: '', texteFin: TEXTE_FIN_DEFAUT, vins: [], commandes: [], commandes_attente: [], venteActive: false, groupeActifId: null,
    dateVente: new Date().toISOString(), heureDebut: null,
    seuil50envoye: false, seuil20envoye: false, historique_edits: [],
    messages_non_parses: [], iaAppels: 0
  };
}

function chargerEtat() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const etat = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      etat.venteActive = false;
      // ne pas forcer de groupe ici : groupeActif() vise le groupe de test par defaut
      etat.messages_non_parses = etat.messages_non_parses || [];
      if (typeof etat.iaAppels !== 'number') etat.iaAppels = 0;
      return etat;
    }
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

// Commande de ce client liee a ce message WhatsApp (message d'origine, ou
// message de "correction" qui l'a remplacee). -1 si aucune.
function trouverCommandeParMsgId(numero, msgId) {
  if (!msgId) return -1;
  return state.commandes.findIndex(c => c.numero === numero &&
    (c.waMsgId === msgId || (c.waMsgIdsLies || []).includes(msgId)));
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
// parseCommandeMulti est extrait dans ./parsing.js (teste par test/parsing.test.js).

// ---------- NUMERO REEL ----------
// Baileys 7 : dans un groupe, msg.key.participant est souvent un identifiant
// anonyme ('150379807375559@lid') et le vrai numero est dans participantAlt.
// Table lid -> numero alimentee par les messages recus, la liste des membres
// des groupes et la table de correspondance que Baileys persiste dans la session.
const lidVersNumero = {};

function apprendreLid(key) {
  const paire = correspondanceLid(key);
  if (paire) lidVersNumero[paire.lid] = paire.numero;
}

async function numeroPourLid(lid) {
  if (!lid) return null;
  if (lidVersNumero[lid]) return lidVersNumero[lid];
  try {
    const pn = await sock?.signalRepository?.lidMapping?.getPNForLID(lid + '@lid');
    if (pn) { lidVersNumero[lid] = numeroDepuisJid(pn); return lidVersNumero[lid]; }
  } catch (e) { console.log('Correspondance LID echouee :', e && e.message); }
  return null;
}

// Identifiants anonymes vus sans vrai numero associe (pour ne jamais les
// confondre avec un telephone, ni les rattacher a une fiche Odoo).
const lidsNonResolus = new Set();

function estIdentifiantAnonyme(numero) {
  return !!numero && (Object.prototype.hasOwnProperty.call(lidVersNumero, numero) || lidsNonResolus.has(numero));
}

// Fiche Odoo d'un numero ; jamais pour un identifiant anonyme (le cache peut
// encore contenir d'anciennes fiches creees avec un identifiant en guise de tel).
function clientOdooPour(numero) {
  return estIdentifiantAnonyme(numero) ? {} : (clientsOdoo[numero] || {});
}

async function resoudreNumero(msg) {
  apprendreLid(msg.key);
  const numero = numeroAuteur(msg.key, lidVersNumero);
  const auteur = msg.key.participant || msg.key.remoteJid || '';
  if (auteur.endsWith('@lid') && numero === numeroDepuisJid(auteur)) {
    const reel = await numeroPourLid(numero);
    if (reel) return reel;
    lidsNonResolus.add(numero);
  }
  return numero;
}

// Lit les membres des groupes configures : chacun vient avec son identifiant
// anonyme et, quand WhatsApp le fournit, son vrai numero.
async function chargerMembresGroupes() {
  for (const g of GROUPES_DISPONIBLES) {
    try {
      const meta = await sock.groupMetadata(g.id);
      let n = 0;
      for (const p of meta.participants || []) {
        if (p.id?.endsWith('@lid') && p.phoneNumber) { lidVersNumero[numeroDepuisJid(p.id)] = numeroDepuisJid(p.phoneNumber); n++; }
        else if (p.lid && p.id?.endsWith('@s.whatsapp.net')) { lidVersNumero[numeroDepuisJid(p.lid)] = numeroDepuisJid(p.id); n++; }
      }
      console.log('Membres groupe ' + g.label + ' : ' + (meta.participants || []).length + ' (' + n + ' numeros connus)');
    } catch (e) { console.log('Membres groupe ' + g.label + ' illisibles :', e && e.message); }
  }
}

// Remplace les identifiants anonymes deja enregistres (commandes, attente,
// messages non parses) par les vrais numeros, puis rattache chaque entree a la
// fiche Odoo de son VRAI numero : la fiche memorisee a la reception peut etre
// une ancienne fausse fiche (creee avec l'identifiant anonyme comme telephone).
// Les commandes manuelles gardent la fiche choisie par l'operateur.
async function reparerNumeros() {
  await chargerMembresGroupes();
  // purger du cache les fiches dont le "telephone" est un identifiant anonyme
  // (utile aussi quand Odoo est indisponible et que le cache disque est reutilise)
  const fausses = Object.keys(clientsOdoo).filter(estIdentifiantAnonyme);
  if (fausses.length) {
    fausses.forEach(k => delete clientsOdoo[k]);
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clientsOdoo, null, 2));
  }
  const cache = {};
  let corriges = 0, fichesCorrigees = 0;
  const nonResolus = new Set();
  const listes = [state.commandes, state.commandes_attente || [], state.messages_non_parses || []];
  for (const liste of listes) {
    for (const c of liste) {
      if (!c.numero) continue;
      if (!c.numero_lid) {
        if (!(c.numero in cache)) cache[c.numero] = await numeroPourLid(c.numero);
        const numero = cache[c.numero];
        if (numero && numero !== c.numero) {
          c.numero_lid = c.numero;
          c.numero = numero;
          delete c.numero_anonyme;
          corriges++;
        } else if (c.numero_anonyme || estIdentifiantAnonyme(c.numero)) {
          nonResolus.add(c.numero);
        }
      }
      if (c.numero_lid && c.source !== 'manuel') {
        const cl = clientsOdoo[c.numero];
        const voulu = cl ? cl.odoo_id : null;
        if ((c.odoo_client_id || null) !== voulu) {
          c.odoo_client_id = voulu;
          fichesCorrigees++;
        }
        if (cl && cl.nom) c.nom = cl.nom;
      }
    }
  }
  if (corriges > 0 || fichesCorrigees > 0) { sauvegarderEtat(); io.emit('update', state); }
  console.log('Reparation numeros : ' + corriges + ' numero(s) corrige(s), ' + fichesCorrigees +
    ' fiche(s) Odoo rattachee(s) au vrai numero, ' + nonResolus.size + ' identifiant(s) anonyme(s) non resolu(s)');
  return { corriges, fichesCorrigees, nonResolus: [...nonResolus] };
}

// ---------- REACTIONS ----------
// Reagit (emoji) sur un message identifie par sa cle Baileys, avec un petit delai
// aleatoire pour rester naturel. Tolere une cle absente ou un sock non connecte.
function reagirSurCle(key, emoji) {
  if (!key || !key.remoteJid || !sock) return;
  const delai = Math.floor(Math.random() * 2000) + 1000;
  setTimeout(async () => {
    try {
      await sock.sendMessage(key.remoteJid, { react: { text: emoji, key } });
    }
    catch (e) { console.log('Reaction echouee :', e.message); }
  }, delai);
}

// Cle serialisable (JSON) suffisante pour reagir plus tard sur un message
function cleReaction(msg) {
  if (!msg || !msg.key) return null;
  const k = { remoteJid: msg.key.remoteJid, id: msg.key.id, fromMe: !!msg.key.fromMe };
  if (msg.key.participant) k.participant = msg.key.participant;
  return k;
}

// ---------- MESSAGES WHATSAPP ----------
function construireMessageVente() {
  let msg = '';
  if (state.texteLibre) msg += state.texteLibre + '\n\n';
  msg += '\u2500'.repeat(30) + '\n';
  state.vins.forEach(vin => {
    const mots = motsContenant(vin.contenant);
    const typeTag = vin.type ? (TAGS_TYPE[vin.type] || '') + ' - ' : '';
    msg += '\n*' + vin.lettre + '.* ' + typeTag + vin.nom + ' \u2014 ' + vin.prix + '\u20ac/' + mots.abr + '\n';
    msg += '   \ud83d\udce6 ' + vin.stock + ' ' + mots.stockPlur + ' disponibles\n';
    if (vin.max) msg += '   \u2b06\ufe0f Maximum ' + vin.max + ' ' + (vin.max > 1 ? mots.qtePlur : mots.qteSing) + ' par personne\n';
    if (vin.min && vin.min > 1) msg += '   \u2b07\ufe0f Minimum ' + vin.min + ' ' + (vin.min > 1 ? mots.qtePlur : mots.qteSing) + ' par commande\n';
  });
  msg += '\n' + '\u2500'.repeat(30) + '\n';
  const texteFin = (typeof state.texteFin === 'string') ? state.texteFin : TEXTE_FIN_DEFAUT;
  if (texteFin.trim()) msg += '\n' + texteFin;
  return msg;
}

function construireMessageStocks() {
  const duree = state.heureDebut ? formatDuree(Date.now() - state.heureDebut) : '?';
  let msg = '\ud83d\udcca *Etat des stocks* \u2014 ' + duree + ' apres le lancement\n';
  msg += '\u2500'.repeat(30) + '\n\n';
  state.vins.forEach(vin => {
    const mots = motsContenant(vin.contenant);
    const pct = vin.stock > 0 ? Math.round((vin.stockRestant / vin.stock) * 100) : 0;
    const vendues = vin.stock - vin.stockRestant;
    const emoji = pct <= 20 ? '\ud83d\udd34' : pct <= 50 ? '\ud83d\udfe1' : '\ud83d\udfe2';
    if (vin.stockRestant === 0) {
      msg += emoji + ' *' + vin.lettre + '.* ' + vin.nom + '\n';
      msg += '   \ud83d\udd34 SOLD OUT (' + vendues + ' ' + mots.stockPlur + ' ' + mots.vendu + ')\n\n';
    } else {
      msg += emoji + ' *' + vin.lettre + '.* ' + vin.nom + '\n';
      msg += '   ' + vin.stockRestant + ' ' + mots.stockPlur + ' ' + mots.restant + ' \u2014 *' + pct + '%* disponible\n\n';
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
    try { await sock.sendMessage(groupeActif(), { text: msg }); } catch (e) { console.log('Erreur 50% :', e.message); }
  }
  if (!state.seuil20envoye && pct <= 20) {
    state.seuil20envoye = true; sauvegarderEtat();
    const msg = '\ud83d\udd34 *Plus que ' + restant + ' bouteilles !*\n\nOn a ecoule *' + vendues + ' bouteilles* en ' + duree + '...\nC\'est le moment ou jamais ! \ud83c\udf77';
    try { await sock.sendMessage(groupeActif(), { text: msg }); } catch (e) { console.log('Erreur 20% :', e.message); }
  }
}

// ---------- SOLD OUT ----------
async function sequenceSoldOut() {
  const duree = state.heureDebut ? formatDuree(Date.now() - state.heureDebut) : '?';
  const vendues = stockTotalInitial();
  const nbCommandes = state.commandes.length;
  console.log('\nSOLD OUT !');
  if (fs.existsSync(STICKER_FILE)) {
    try {
      const stickerBuffer = fs.readFileSync(STICKER_FILE);
      await sock.sendMessage(groupeActif(), { sticker: stickerBuffer });
    }
    catch (e) { await sock.sendMessage(groupeActif(), { text: '\ud83d\udd34 *SOLD OUT !*' }); }
  } else { await sock.sendMessage(groupeActif(), { text: '\ud83d\udd34 *SOLD OUT !*' }); }
  setTimeout(async () => {
    const fin = '\ud83d\udd25 *SOLD OUT en ' + duree + '* \u26a1\n\n*Un enorme merci a tous* \ud83d\ude4f\nVous avez ete ultra rapides !\n\n\ud83d\udce6 *' + vendues + ' bouteilles* vendues\n\ud83d\udc65 *' + nbCommandes + ' commandes* enregistrees\n\nVous serez contactes prochainement. \ud83c\udf77';
    try { await sock.sendMessage(groupeActif(), { text: fin }); } catch (e) { console.log('Erreur fin :', e.message); }
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

function programmerVenteServeur(heureISO, texteLibre, texteFin, vins) {
  annulerProgrammationServeur();
  const cible = new Date(heureISO);
  const delaiMs = cible - Date.now();
  if (delaiMs <= 0) return { error: 'Heure déjà passée' };

  programmationHeure = heureISO;
  programmationData = { texteLibre, texteFin, vins };
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

    // B6 : conserver le groupe actif avant le reset (etatInitial remet groupeActifId a null)
    const groupeAvantReset = groupeActif();
    state = etatInitial();
    state.groupeActifId = groupeAvantReset || null;
    state.texteLibre = texteLibre || '';
    state.texteFin = (typeof texteFin === 'string') ? texteFin : TEXTE_FIN_DEFAUT;
    state.vins = vinsAvecLettres;
    state.venteActive = true;
    state.dateVente = new Date().toISOString();
    state.heureDebut = Date.now();
    sauvegarderEtat();
    io.emit('update', state);

    try {
      await sock.sendMessage(groupeActif(), { text: construireMessageVente() });
      console.log('\nVente programmee lancee : ' + vinsAvecLettres.length + ' vins vers ' + groupeActif());
      io.emit('vente_lancee_auto');
    } catch (e) { console.log('Erreur envoi vente programmee :', e.message); }
  }, delaiMs);

  console.log('Vente programmee a ' + cible.toLocaleTimeString('fr-BE', { timeZone: FUSEAU }) + ' (dans ' + Math.round(delaiMs / 60000) + ' min)');
  return { ok: true, heureISO };
}

// ---------- ANALYSE IA D'UN MESSAGE NON PARSE (Phase 1 : observation seule) ----------
// Appele quand le regex echoue. Non bloquant, jamais d'envoi WhatsApp.
// Le resultat est juste enregistre dans state.messages_non_parses pour le dashboard.
function analyserMessageNonParse(msg, body, numeroContact, nom, estDuGroupe) {
  if (!iaActivee()) return;
  const texteMsg = String(body || '').trim();
  if (!texteMsg) return;
  if ((state.iaAppels || 0) >= IA_MAX_APPELS_PAR_VENTE) {
    console.log('[IA] plafond de', IA_MAX_APPELS_PAR_VENTE, 'appels/vente atteint, message ignore');
    return;
  }
  state.iaAppels = (state.iaAppels || 0) + 1;
  const vinsSnapshot = state.vins.map(v => ({ lettre: v.lettre, nom: v.nom, type: v.type, contenant: v.contenant }));
  const clientOdoo = clientOdooPour(numeroContact);
  const waMsgKey = cleReaction(msg);

  analyserMessageIA(texteMsg, vinsSnapshot).then(ia => {
    const entree = {
      heure: heureBE(),
      numero: numeroContact,
      nom: clientOdoo.nom || nom || '',
      odoo_client_id: clientOdoo.odoo_id || null,
      message: texteMsg.slice(0, 500),
      source: estDuGroupe ? 'groupe' : 'prive',
      waMsgKey,
      ia: ia || null
    };
    state.messages_non_parses = state.messages_non_parses || [];
    state.messages_non_parses.push(entree);
    if (state.messages_non_parses.length > 200) state.messages_non_parses.shift();
    sauvegarderEtat();
    io.emit('update', state);
    const resume = ia
      ? ia.intention + ' ' + (ia.lignes.map(l => l.lettre + ':' + l.qte).join(' ') || '-') + ' (conf ' + ia.confiance + ')'
      : 'analyse indisponible';
    console.log('[IA] non-parse "' + texteMsg.slice(0, 40) + '" -> ' + resume);
  }).catch(e => console.log('[IA] enregistrement echoue :', e && e.message));
}

// ---------- TRAITEMENT COMMANDE ----------
const REACTION_OK = '👍', REACTION_MODIF = '👇', REACTION_REFUS = '❌';

// Message "sold out" d'un vin : une seule fois par vente (une edition qui remet
// puis reprend le stock ne doit pas le renvoyer).
async function annoncerSoldOutVins(lignes) {
  for (const ligne of lignes) {
    const vin = state.vins.find(v => v.lettre === ligne.lettre);
    if (!vin || vin.stockRestant !== 0 || vin.soldOutAnnonce) continue;
    vin.soldOutAnnonce = true;
    const mots = motsContenant(vin.contenant);
    const msgSoldOut = '🔴 *' + vin.lettre + '. ' + vin.nom + ' — SOLD OUT !*\n\n' + mots.tous + ' ' + mots.qtePlur + ' ont trouvé preneur. Merci ! 🍷';
    try { await sock.sendMessage(groupeActif(), { text: msgSoldOut }); }
    catch (e) { console.log('Erreur sold out vin :', e.message); }
  }
}

// Remplace une commande existante par un nouveau texte : edition du message
// d'origine, ou "correction" envoyee en reponse. Le stock de l'ancienne version
// est remis, puis les memes regles qu'une commande normale s'appliquent (le max
// ne compte pas l'ancienne version). Retourne l'action pour l'historique.
async function remplacerCommande(cmdIndex, nouveauTexte, cleReact) {
  const ancienne = state.commandes[cmdIndex];
  for (const ligne of ancienne.lignes) {
    const vin = state.vins.find(v => v.lettre === ligne.lettre);
    if (vin) vin.stockRestant += ligne.qte;
  }
  const lignesParsees = parseCommandeMulti(nouveauTexte);
  if (!lignesParsees) {
    state.commandes.splice(cmdIndex, 1);
    reagirSurCle(cleReact, REACTION_REFUS);
    return 'annulation';
  }
  const { lignesValidees, aEteModifie, aEteRefuse } =
    validerLignes(lignesParsees, state.vins, state.commandes, ancienne.numero, cmdIndex);
  if (lignesValidees.length === 0) {
    state.commandes.splice(cmdIndex, 1);
    reagirSurCle(cleReact, REACTION_REFUS);
    return 'annulation_min';
  }
  for (const ligne of lignesValidees) {
    const vin = state.vins.find(v => v.lettre === ligne.lettre);
    if (vin) vin.stockRestant -= ligne.qte;
  }
  state.commandes[cmdIndex] = { ...ancienne, lignes: lignesValidees, msgOriginal: nouveauTexte, edite: true };
  reagirSurCle(cleReact, (aEteModifie || aEteRefuse) ? REACTION_MODIF : REACTION_OK);
  await annoncerSoldOutVins(lignesValidees);
  return 'modification';
}

// opts.waMsgId   : id du message auquel rattacher la commande (defaut : msg.key.id)
// opts.cleReact  : message sur lequel reagir (defaut : msg)
// opts.ignorerCitation : ne pas traiter le message comme une reponse (edition)
async function traiterCommande(msg, body, numeroContact, nom, estDuGroupe, opts = {}) {
  const waMsgId = opts.waMsgId || msg.key?.id || null;
  const msgId = waMsgId || (numeroContact + '|' + body);
  if (estDejaTraite(msgId)) { console.log('Doublon ignore :', msgId.slice(0, 40)); return; }
  const cle = opts.cleReact || cleReaction(msg);

  const lignesParsees = parseCommandeMulti(body);
  if (!lignesParsees) { analyserMessageNonParse(msg, body, numeroContact, nom, estDuGroupe); return; }

  // Reponse a sa propre commande : "correction" => remplacement, sinon alerte
  const citation = opts.ignorerCitation ? null : extraireCitation(msg);
  const idxCite = citation ? trouverCommandeParMsgId(numeroContact, citation.idCite) : -1;
  if (idxCite >= 0 && estMessageCorrection(body)) {
    const ancienMessage = state.commandes[idxCite].msgOriginal;
    const action = await remplacerCommande(idxCite, body, cle);
    if (action === 'modification' && waMsgId) {
      const cmd = state.commandes[idxCite];
      cmd.waMsgIdsLies = [...(cmd.waMsgIdsLies || []), waMsgId];
      cmd.corrige_par_reponse = true;
    }
    state.historique_edits = state.historique_edits || [];
    state.historique_edits.push({
      heure: heureBE(), numero: numeroContact, nom,
      ancienMessage, nouveauMessage: body, action: 'correction_reponse_' + action
    });
    sauvegarderEtat(); io.emit('update', state);
    console.log('[CORRECTION] ' + (nom || numeroContact) + ' -> ' + action + ' | Restant : ' + stockTotalRestant());
    await verifierSeuils();
    return;
  }

  const { lignesValidees, aEteModifie, aEteRefuse } =
    validerLignes(lignesParsees, state.vins, state.commandes, numeroContact);

  if (lignesValidees.length > 0) {
    reagirSurCle(cle, (aEteModifie || aEteRefuse) ? REACTION_MODIF : REACTION_OK);
  } else {
    reagirSurCle(cle, REACTION_REFUS);
    const lignesAttente = [];
    for (const { lettre, qte } of lignesParsees) {
      const vin = state.vins.find(v => v.lettre === lettre);
      if (!vin) continue;
      lignesAttente.push({ lettre, qte, odooId: vin.odooId });
    }
    if (lignesAttente.length > 0) {
      const clientOdoo = clientOdooPour(numeroContact);
      state.commandes_attente = state.commandes_attente || [];
      state.commandes_attente.push({
        heure: heureBE(), numero: numeroContact,
        nom: clientOdoo.nom || nom, odoo_client_id: clientOdoo.odoo_id || null,
        lignes: lignesAttente, source: estDuGroupe ? 'groupe' : 'prive',
        msgOriginal: body, en_attente: true, waMsgId,
        numero_anonyme: estIdentifiantAnonyme(numeroContact) || undefined
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

  await annoncerSoldOutVins(lignesValidees);

  const clientOdoo = clientOdooPour(numeroContact);
  const commande = {
    heure: heureBE(),
    numero: numeroContact, nom: clientOdoo.nom || nom,
    odoo_client_id: clientOdoo.odoo_id || null,
    lignes: lignesValidees, source: estDuGroupe ? 'groupe' : 'prive', msgOriginal: body,
    waMsgId, numero_anonyme: estIdentifiantAnonyme(numeroContact) || undefined
  };
  // Reponse a sa propre commande sans mot "correction" : ajoutee, mais signalee
  if (idxCite >= 0) {
    commande.suspect = true;
    commande.alerte = 'Répond à sa commande de ' + state.commandes[idxCite].heure +
      ' sans dire « correction » : doublon ou ajout ? À vérifier.';
  }
  state.commandes.push(commande);
  sauvegarderEtat();
  io.emit('update', state);
  io.emit('nouvelle_commande', commande);
  const resume = lignesValidees.map(l => l.lettre + ':' + l.qte + (l.modifie ? '(max)' : '')).join(' | ');
  console.log('[' + commande.heure + '] ' + (commande.nom || numeroContact) + ' -> ' + resume + ' | Restant : ' + stockTotalRestant() + (idxCite >= 0 ? ' | ALERTE reponse sans correction' : ''));
  await verifierSeuils();
}

// ---------- EXPRESS ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());

let dernierQrCode = null;
io.on('connection', socket => {
  // pousser l'etat WhatsApp reel a l'ouverture du dashboard (sinon le bandeau
  // reste bloque sur "Connexion...")
  if (dernierQrCode) socket.emit('qr_code', dernierQrCode);
  else if (waConnecte) socket.emit('whatsapp_ready');
  else socket.emit('whatsapp_disconnected');
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

// Regroupe les commandes par client et determine la fiche Odoo de chacun.
// Priorite : fiche choisie a la main (commande manuelle) > fiche du vrai numero
// dans le cache Odoo > fiche memorisee sur la commande. Un identifiant anonyme
// n'est jamais rattache ni cree : statut 'a_associer'.
function preparerOrders() {
  const map = {};
  for (const cmd of state.commandes) {
    const c = map[cmd.numero] || (map[cmd.numero] = {
      numero: cmd.numero, nom: '', idManuel: null, idCommande: null, anonyme: false, lignesConsolid: {}
    });
    if (!c.nom && cmd.nom) c.nom = cmd.nom;
    if (cmd.source === 'manuel' && cmd.odoo_client_id && !c.idManuel) c.idManuel = cmd.odoo_client_id;
    if (cmd.odoo_client_id && !c.idCommande) c.idCommande = cmd.odoo_client_id;
    if (cmd.numero_anonyme || estIdentifiantAnonyme(cmd.numero)) c.anonyme = true;
    for (const ligne of cmd.lignes) {
      if (!c.lignesConsolid[ligne.lettre]) c.lignesConsolid[ligne.lettre] = { lettre: ligne.lettre, qteTotal: 0 };
      c.lignesConsolid[ligne.lettre].qteTotal += ligne.qte;
    }
  }
  return Object.values(map).map(c => {
    const cache = c.anonyme ? null : clientsOdoo[c.numero];
    const odooId = c.idManuel || (cache && cache.odoo_id) || (c.anonyme ? null : c.idCommande) || null;
    const statut = odooId ? 'existant' : (c.anonyme ? 'a_associer' : 'nouveau');
    return { numero: c.numero, nom: (cache && cache.nom) || c.nom, odooId, statut, lignesConsolid: c.lignesConsolid };
  });
}

// Apercu avant creation : affiche dans la confirmation du dashboard
app.get('/api/odoo/apercu-orders', requireAuth, (req, res) => {
  const clients = preparerOrders();
  const resume = c => ({ numero: c.numero, nom: c.nom || '' });
  res.json({
    total: clients.length,
    existants: clients.filter(c => c.statut === 'existant').length,
    nouveaux: clients.filter(c => c.statut === 'nouveau').map(resume),
    aAssocier: clients.filter(c => c.statut === 'a_associer').map(resume)
  });
});

let creationOrdersEnCours = false;   // anti double-clic

app.post('/api/odoo/creer-orders', requireAuth, async (req, res) => {
  if (state.commandes.length === 0) return res.status(400).json({ error: 'Aucune commande' });
  if (creationOrdersEnCours) return res.status(409).json({ error: 'Creation deja en cours' });
  creationOrdersEnCours = true;
  try {
    res.json({ ok: true, resultats: await creerOrdersOdoo() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    creationOrdersEnCours = false;
  }
});

async function creerOrdersOdoo() {
  const resultats = [];
  for (const client of preparerOrders()) {
    const numero = client.numero;
    if (client.statut === 'a_associer') {
      resultats.push({ numero, nom: client.nom, status: 'a_associer',
        message: 'numéro WhatsApp non identifié, rien créé : supprimer la commande et la ressaisir en manuel avec la bonne fiche' });
      console.log('SO ignore (identifiant anonyme non resolu) pour ' + (client.nom || numero));
      continue;
    }
    let odooIdFinal = client.odooId;
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
        try { await sock.sendMessage(numero + '@s.whatsapp.net', { text: msgPrive }); } catch (e) { console.log('Erreur msg prive :', e.message); }
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
  return resultats;
}

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
  const { texteLibre, texteFin, vins } = req.body;
  if (!vins || vins.length === 0) return res.status(400).json({ error: 'Aucun vin defini' });
  const vinsAvecLettres = vins.map((vin, i) => ({
    lettre: String.fromCharCode(65 + i),
    nom: vin.nom || '', prix: vin.prix || '', type: vin.type || '',
    contenant: vin.contenant || 'bouteille',
    stock: parseInt(vin.stock) || 0, stockRestant: parseInt(vin.stock) || 0,
    min: parseInt(vin.min) || 1, max: parseInt(vin.max) || null, odooId: vin.odooId || null
  }));
  // B6 : conserver le groupe actif avant le reset (etatInitial remet groupeActifId a null)
  const groupeAvantReset = groupeActif();
  state = etatInitial();
  state.groupeActifId = groupeAvantReset || null;
  state.texteLibre = texteLibre || '';
  state.texteFin = (typeof texteFin === 'string') ? texteFin : TEXTE_FIN_DEFAUT;
  state.vins = vinsAvecLettres;
  state.venteActive = true;
  state.dateVente = new Date().toISOString();
  state.heureDebut = Date.now();
  sauvegarderEtat();
  io.emit('update', state);
  try {
    const sendResult = await sock.sendMessage(groupeActif(), { text: construireMessageVente() });
    console.log('\nVente demarree : ' + vinsAvecLettres.length + ' vins vers ' + groupeActif());
    console.log('sendMessage result key:', sendResult?.key?.id?.substring(0, 10) || 'null/undefined');
    res.json({ ok: true });
  } catch (e) {
    console.log('===== DETAIL ERREUR ENVOI =====');
    console.log('message :', e && e.message);
    console.log('name    :', e && e.name);
    console.log('stack   :', e && e.stack);
    console.log('===============================');
    res.json({ ok: true, warning: 'Vente demarree mais message non envoye' });
  }
});

app.post('/api/programmer-vente', requireAuth, (req, res) => {
  const { heureISO, texteLibre, texteFin, vins } = req.body;
  if (!heureISO || !vins || vins.length === 0) return res.status(400).json({ error: 'Invalide' });
  const result = programmerVenteServeur(heureISO, texteLibre, texteFin, vins);
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
  try { await sock.sendMessage(groupeActif(), { text: construireMessageStocks() }); res.json({ ok: true }); }
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
    nouvellesLignes.push({ ...(anciennesLignes.find(l => l.lettre === lettre) || { manuel: true }), lettre, qte: qteFin, odooId: vin.odooId });
  }
  state.commandes[idx].lignes = nouvellesLignes;
  state.commandes[idx].modifie_manuellement = true;
  sauvegarderEtat(); io.emit('update', state);
  res.json({ ok: true });
});

// Ajoute une commande "manuelle" avec les memes verifications de stock que le
// bouton du dashboard. Reutilise par /api/commande-manuelle et par la validation
// d'un message detecte par l'IA. Retourne { ok } ou { error }.
function ajouterCommandeManuelle({ numero, nom, lignes, odoo_client_id, msgOriginal }) {
  if (!numero || !lignes || lignes.length === 0) return { error: 'Invalide' };
  const lignesValidees = [];
  let modifie = false;   // une ligne demandee a ete plafonnee (stock) ou ecartee
  for (const { lettre, qte } of lignes) {
    const vin = state.vins.find(v => v.lettre === String(lettre || '').toUpperCase());
    if (!vin) { modifie = true; continue; }
    const qteDemandee = parseInt(qte) || 0;
    const qteFin = Math.min(qteDemandee, vin.stockRestant);
    if (qteFin <= 0) { modifie = true; continue; }
    if (qteFin < qteDemandee) modifie = true;
    vin.stockRestant -= qteFin;
    lignesValidees.push({ lettre: String(lettre).toUpperCase(), qte: qteFin, odooId: vin.odooId, manuel: true });
  }
  if (lignesValidees.length === 0) return { error: 'Aucune ligne valide' };
  const commande = {
    heure: heureBE(),
    numero: String(numero).replace(/\D/g, ''), nom: nom || '',
    odoo_client_id: odoo_client_id || null,
    lignes: lignesValidees, source: 'manuel',
    msgOriginal: msgOriginal || '[Ajout manuel]', manuel: true
  };
  state.commandes.push(commande);
  sauvegarderEtat(); io.emit('update', state); io.emit('nouvelle_commande', commande);
  return { ok: true, modifie };
}

app.post('/api/commande-manuelle', requireAuth, (req, res) => {
  const { numero, nom, lignes, odoo_client_id } = req.body;
  const r = ajouterCommandeManuelle({ numero, nom, lignes, odoo_client_id });
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true });
});

// ---------- MESSAGES NON PARSES (analyse IA, phase 1) ----------
app.get('/api/messages-non-parses', requireAuth, (req, res) => res.json(state.messages_non_parses || []));

app.post('/api/message-non-parse/:index/valider', requireAuth, (req, res) => {
  const idx = parseInt(req.params.index);
  const arr = state.messages_non_parses || [];
  if (isNaN(idx) || idx < 0 || idx >= arr.length) return res.status(400).json({ error: 'Index invalide' });
  const m = arr[idx];
  const lignes = (req.body && Array.isArray(req.body.lignes) && req.body.lignes.length)
    ? req.body.lignes
    : ((m.ia && m.ia.lignes) || []);
  if (!lignes.length) return res.status(400).json({ error: 'Aucune ligne a valider' });
  const r = ajouterCommandeManuelle({
    numero: m.numero, nom: m.nom, odoo_client_id: m.odoo_client_id,
    lignes, msgOriginal: m.message
  });
  if (r.error) {
    // rien n'a pu etre valide (stock epuise) -> croix sur le message du client
    reagirSurCle(m.waMsgKey, '❌');
    return res.status(400).json(r);
  }
  // meme signalisation que le parsing auto : pouce tel quel / doigt bas si ajuste au stock
  reagirSurCle(m.waMsgKey, r.modifie ? '👇' : '👍');
  arr.splice(idx, 1);
  sauvegarderEtat(); io.emit('update', state);
  res.json({ ok: true });
});

app.delete('/api/message-non-parse/:index', requireAuth, (req, res) => {
  const idx = parseInt(req.params.index);
  const arr = state.messages_non_parses || [];
  if (isNaN(idx) || idx < 0 || idx >= arr.length) return res.status(400).json({ error: 'Index invalide' });
  arr.splice(idx, 1);
  sauvegarderEtat(); io.emit('update', state);
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
let sock = null;
let resetWhatsAppEnCours = false;
let waVersionCache = null;
let waConnecte = false;
let waGeneration = 0;          // incremente a chaque (re)demarrage : invalide les anciennes sockets
let waReconnectTimer = null;   // un seul timer de reconnexion a la fois
let waEchecsConsecutifs = 0;   // pour le backoff

// Version du protocole WhatsApp Web. La version embarquee par Baileys rc13 est
// trop vieille et se fait refuser (code 405) -> on recupere la version courante.
// Fallback : une version connue bonne (sept. 2026), plus recente que celle de rc13.
async function obtenirVersionWA() {
  if (waVersionCache) return waVersionCache;
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log('Version WhatsApp Web :', version.join('.'), isLatest ? '(a jour)' : '(pas la plus recente)');
    waVersionCache = version;
    return version;
  } catch (e) {
    console.log('Recuperation version WA echouee (' + (e && e.message) + '), fallback 2.3000.1043857760');
    return [2, 3000, 1043857760];
  }
}

// Planifie UNE reconnexion (jamais plusieurs en parallele), avec backoff.
// 5s, 10s, 20s, 40s... puis palier 5 min a partir de ~6 echecs. Objectif :
// arreter de solliciter WhatsApp quand il bloque (code 405 apres abus) pour
// laisser le blocage temporaire retomber.
function planifierReconnexion() {
  if (waReconnectTimer || resetWhatsAppEnCours) return;
  waEchecsConsecutifs++;
  const delai = waEchecsConsecutifs <= 5
    ? 5000 * Math.pow(2, waEchecsConsecutifs - 1)   // 5s, 10s, 20s, 40s, 80s
    : 300000;                                        // puis 5 min
  console.log('Reconnexion WhatsApp dans ' + Math.round(delai / 1000) + 's (tentative #' + waEchecsConsecutifs + ')');
  waReconnectTimer = setTimeout(() => { waReconnectTimer = null; demarrerWhatsApp(); }, delai);
}

// Ferme la session WhatsApp courante, vide le dossier de session et relance une
// connexion vierge (=> nouveau QR sur le dashboard). Declenche par le bouton
// "Reconnecter WhatsApp". Refuse si une vente est active (verifie cote endpoint).
async function reinitialiserWhatsApp() {
  if (resetWhatsAppEnCours) return { error: 'Reinitialisation deja en cours' };
  resetWhatsAppEnCours = true;
  try {
    if (waReconnectTimer) { clearTimeout(waReconnectTimer); waReconnectTimer = null; }
    const etaitConnecte = waConnecte;
    dernierQrCode = null;
    waConnecte = false;
    waGeneration++;   // invalide immediatement toutes les sockets/timers en vol
    try { sock?.ev?.removeAllListeners?.(); } catch (e) {}
    // logout propre seulement si on etait reellement connecte (sinon inutile et lent)
    if (etaitConnecte && sock?.logout) {
      try {
        await Promise.race([
          Promise.resolve(sock.logout()),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
        ]);
      } catch (e) { console.log('logout WA :', e && e.message); }
    }
    try { sock?.end?.(undefined); } catch (e) {}
    sock = null;
    await new Promise(r => setTimeout(r, 800));
    try {
      for (const f of fs.readdirSync(AUTH_DIR)) {
        if (f === 'wc_state') continue;   // ne pas toucher a l'etat des ventes / caches
        // garder la table identifiant anonyme -> vrai numero (independante de la session,
        // sert a retrouver les vrais numeros des commandes deja enregistrees)
        if (f.startsWith('lid-mapping-')) continue;
        fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true });
      }
      console.log('Session WhatsApp effacee');
    } catch (e) { console.log('Effacement session WA :', e && e.message); }
    waEchecsConsecutifs = 0;
    io.emit('whatsapp_disconnected');
    await demarrerWhatsApp();
  } finally {
    resetWhatsAppEnCours = false;
  }
  return { ok: true };
}

async function demarrerWhatsApp() {
  if (waReconnectTimer) { clearTimeout(waReconnectTimer); waReconnectTimer = null; }
  const gen = ++waGeneration;

  // fermer proprement toute socket precedente avant d'en creer une nouvelle
  try { sock?.ev?.removeAllListeners?.(); } catch (e) {}
  try { sock?.end?.(undefined); } catch (e) {}
  waConnecte = false;

  const gId = groupeActif();
  if (!gId) console.log('Aucun groupe WhatsApp configure');
  else console.log('Groupe actif au demarrage :', gId);

  // Session persistante dans le volume Railway (réutilise le dossier wwebjs_auth existant)
  const { state: waAuthState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const version = await obtenirVersionWA();
  if (gen !== waGeneration) return;   // une autre (re)initialisation a pris la main pendant l'await

  sock = makeWASocket({
    version,
    auth: waAuthState,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Wine Cellar Bot', 'Chrome', '5.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (gen !== waGeneration) return;   // event d'une socket obsolete
    if (qr) {
      console.log('QR Code recu, disponible sur le dashboard');
      dernierQrCode = qr;
      waEchecsConsecutifs = 0;   // WhatsApp nous parle : le chemin de connexion fonctionne
      io.emit('qr_needed');
      io.emit('qr_code', qr);
    }

    if (connection === 'open') {
      dernierQrCode = null;
      waConnecte = true;
      waEchecsConsecutifs = 0;
      const numero = sock.user?.id?.split(':')[0] || sock.user?.id || '?';
      console.log('\nBot connecte ! Numero :', numero);
      console.log('Dashboard : http://localhost:' + PORT + '\n');
      io.emit('whatsapp_ready');
      // membres des groupes d'abord : le cache Odoo ignore les fiches a identifiant anonyme
      await chargerMembresGroupes();
      if (ODOO_API_KEY) {
        console.log('Sync clients Odoo...');
        clientsOdoo = await construireCacheClients();
      }
      // membres des groupes (vrais numeros) + reparation des commandes deja enregistrees
      reparerNumeros().catch(e => console.log('Reparation numeros :', e && e.message));
    }

    if (connection === 'close') {
      waConnecte = false;
      io.emit('whatsapp_disconnected');
      const code = lastDisconnect?.error?.output?.statusCode;
      const deconnecteVolontairement = code === DisconnectReason.loggedOut;
      console.log('WhatsApp deconnecte. Code :', code);
      if (deconnecteVolontairement) {
        console.log('Session invalidee (loggedOut) — cliquer "Reconnecter WhatsApp" pour un nouveau QR');
        io.emit('whatsapp_loggedout');
      } else if (!resetWhatsAppEnCours) {
        planifierReconnexion();
      }
    }
  });

  // Réception des messages normaux
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (gen !== waGeneration) return;
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      // Ignorer les messages édités (traités par le listener suivant)
      if (extraireEdition(msg)) continue;

      // Extraction du corps — couvre tous les formats Baileys 7.x
      const body = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || msg.message?.videoMessage?.caption
        || msg.message?.buttonsResponseMessage?.selectedDisplayText
        || msg.message?.listResponseMessage?.title
        || '';

      // Capturer le sticker sold-out si pas encore enregistré
      if (msg.message?.stickerMessage && !fs.existsSync(STICKER_FILE)) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          fs.writeFileSync(STICKER_FILE, buffer);
          console.log('Sticker capture !');
        } catch (e) { console.log('Sticker :', e.message); }
        continue;
      }

      if (!state.venteActive) continue;

      // Seules les commandes du groupe actif comptent : messages prives et
      // autres groupes ignores en silence.
      if (msg.key.remoteJid !== groupeActif()) continue;

      const numeroContact = await resoudreNumero(msg);
      const nom = msg.pushName || clientOdooPour(numeroContact).nom || '';

      await traiterCommande(msg, body, numeroContact, nom, true);

      if (stockTotalRestant() === 0) {
        state.venteActive = false; sauvegarderEtat();
        io.emit('sold_out'); await sequenceSoldOut();
      }
    }
  });

  // Messages édités (protocolMessage type 14, enveloppé ou non : voir extraireEdition)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (gen !== waGeneration) return;
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const edition = extraireEdition(msg);
      if (!edition) continue;
      if (!state.venteActive) { console.log('Edit ignore (vente inactive)'); continue; }
      if (msg.key.remoteJid !== groupeActif()) continue;

      const { idOriginal, nouveauTexte } = edition;
      const numeroContact = await resoudreNumero(msg);
      const nom = msg.pushName || clientOdooPour(numeroContact).nom || '';
      // reagir sur le message d'origine (celui que le client voit), pas sur l'edition
      const cleReact = { ...cleReaction(msg), id: idOriginal };

      const cmdIndex = trouverCommandeParMsgId(numeroContact, idOriginal);
      const entreeHistorique = {
        heure: heureBE(),
        numero: numeroContact, nom,
        ancienMessage: cmdIndex >= 0 ? state.commandes[cmdIndex].msgOriginal : '(inconnu)',
        nouveauMessage: nouveauTexte, action: ''
      };

      if (cmdIndex === -1) {
        if (parseCommandeMulti(nouveauTexte)) {
          entreeHistorique.action = 'nouveau_depuis_edit';
          // la version d'origine avait ete refusee (onglet attente) : la nouvelle la remplace
          state.commandes_attente = (state.commandes_attente || []).filter(a => a.waMsgId !== idOriginal);
          messagesTraites.delete(idOriginal);
          await traiterCommande(msg, nouveauTexte, numeroContact, nom, true,
            { waMsgId: idOriginal, cleReact, ignorerCitation: true });
        } else { entreeHistorique.action = 'ignore'; }
      } else {
        entreeHistorique.action = await remplacerCommande(cmdIndex, nouveauTexte, cleReact);
      }
      console.log('[EDIT] ' + (nom || numeroContact) + ' -> ' + entreeHistorique.action + ' | Restant : ' + stockTotalRestant());

      state.historique_edits = state.historique_edits || [];
      state.historique_edits.push(entreeHistorique);
      sauvegarderEtat(); io.emit('update', state);
      await verifierSeuils();

      if (stockTotalRestant() === 0) {
        state.venteActive = false; sauvegarderEtat();
        io.emit('sold_out'); await sequenceSoldOut();
      }
    }
  });
}


// ---------- API GROUPES ----------
app.get('/api/groupes', requireAuth, (req, res) => {
  res.json({ disponibles: GROUPES_DISPONIBLES, actifId: groupeActif() });
});

app.post('/api/groupe-actif', requireAuth, (req, res) => {
  if (state.venteActive) {
    return res.status(400).json({ error: "Impossible de changer de groupe pendant une vente active. Stoppez la vente d'abord." });
  }
  const { groupeId } = req.body;
  const groupe = GROUPES_DISPONIBLES.find(g => g.id === groupeId);
  if (!groupe) return res.status(400).json({ error: 'Groupe inconnu : ' + groupeId });
  state.groupeActifId = groupeId;
  sauvegarderEtat();
  io.emit('update', state);
  console.log('Groupe actif change vers :', groupe.label, '(' + groupeId + ')');
  res.json({ ok: true, label: groupe.label, id: groupeId });
});

// ---------- REPARATION DES NUMEROS (identifiants anonymes -> vrais numeros) ----------
app.post('/api/reparer-numeros', requireAuth, async (req, res) => {
  if (!waConnecte) return res.status(409).json({ error: 'WhatsApp non connecte' });
  res.json({ ok: true, ...(await reparerNumeros()) });
});

// ---------- RECONNEXION WHATSAPP ----------
app.post('/api/whatsapp/reset', requireAuth, async (req, res) => {
  if (state.venteActive) {
    return res.status(400).json({ error: "Vente active : stoppez-la avant de reconnecter WhatsApp." });
  }
  const r = await reinitialiserWhatsApp();
  if (r.error) return res.status(409).json(r);
  console.log('Reconnexion WhatsApp demandee depuis le dashboard');
  res.json({ ok: true });
});

server.listen(PORT, () => {
  console.log('Demarrage Wine Cellar Multi-Vins v5...');
  demarrerWhatsApp();
});
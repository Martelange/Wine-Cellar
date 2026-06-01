// ============================================================
//  WINE CELLAR – Bot WhatsApp Ventes Flash v13
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
const ODOO_URL = process.env.ODOO_URL || '';
const ODOO_DB = process.env.ODOO_DB || '';
const ODOO_API_KEY = process.env.ODOO_API_KEY || '';

const DATA_FILE = path.join(__dirname, 'vente_en_cours.json');
const CLIENTS_FILE = path.join(__dirname, 'clients_odoo.json');
const STICKER_FILE = path.join(__dirname, 'sticker_soldout.webp');

// const GROUPE_ID = '120363425293223285@g.us'; // Groupe Test
const GROUPE_ID = '120363426346242051@g.us'; // Groupe Test Prod
const DELAI_MERCI = 20000;

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
    vin: '', description: '', stockTotal: 0, stockRestant: 0,
    commandes: [], venteActive: false,
    dateVente: new Date().toISOString(), heureDebut: null,
    seuil50envoye: false, seuil20envoye: false
  };
}

function chargerEtat() {
  if (fs.existsSync(DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
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

const NOMBRES_LETTRES = {
  'une': 1, 'un': 1, 'deux': 2, 'trois': 3, 'quatre': 4,
  'cinq': 5, 'six': 6, 'sept': 7, 'huit': 8, 'neuf': 9,
  'dix': 10, 'onze': 11, 'douze': 12
};

function corrigerFautes(txt) {
  return txt
    .replace(/c[0-9a-z]{0,2}[i1][s5][s5][e3]s?/g, 'caisse')
    .replace(/c[a@][i1][s5]{1,2}[e3]s?/g, 'caisse')
    .replace(/c4rtons?/g, 'carton')
    .replace(/b[o0]ut[e3][i1]ll[e3]s?/g, 'bouteille')
    .replace(/b[o0]ut[e3]ll[e3]s?/g, 'bouteille')
    .replace(/b[o0]ut[e3][i1]l[e3]s?/g, 'bouteille')
    .replace(/b[o0]utt[e3][i1]ll[e3]s?/g, 'bouteille')
    .replace(/b[o0]uts?\b/g, 'bouteille')
    .replace(/btls?\b/g, 'bouteille')
    .replace(/\bb[o0]t\b/g, 'bouteille');
}

function parseCommande(msg) {
  let txt = msg.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();

  for (const [mot, val] of Object.entries(NOMBRES_LETTRES)) {
    txt = txt.replace(new RegExp('\\b' + mot + '\\b', 'g'), String(val));
  }

  txt = corrigerFautes(txt);

  const caisse = txt.match(/(\d+)\s*(caisse|carton)s?/);
  if (caisse) return parseInt(caisse[1]) * 6;

  const bouteille = txt.match(/(\d+)\s*bouteilles?/);
  if (bouteille) return parseInt(bouteille[1]);

  const court = txt.match(/(\d+)\s*b\b/);
  if (court) return parseInt(court[1]);

  const seul = txt.match(/^(\d+)\s*(stp|svp|merci|please|si|$)/);
  if (seul && parseInt(seul[1]) <= 50) return parseInt(seul[1]);

  return null;
}

// Recuperation du vrai numero — gere @lid (nouveau systeme WhatsApp)
async function getNumeroReel(msg) {
  const brut = msg.author || msg.from;

  if (brut.includes('@lid')) {
    try {
      const contact = await msg.getContact();
      // id.user contient le vrai numero belge (ex: 32477979419)
      if (contact.id && contact.id.user) return contact.id.user;
      if (contact.number) return contact.number;
    } catch (e) {
      console.log('\u26a0\ufe0f Erreur getContact :', e.message);
      return brut.replace(/@lid/g, '');
    }
  }

  return brut.replace(/@c\.us|@g\.us/g, '').replace(/\D/g, '');
}

// ✅ Like avec delai aleatoire — plus humain, non-bloquant
function likeAvecDelai(msg) {
  const delai = Math.floor(Math.random() * 2000) + 1000; // entre 1 et 3 secondes
  setTimeout(async () => {
    try {
      await msg.react('\ud83d\udc4d');
    } catch (e) {
      console.log('\u26a0\ufe0f Like \u00e9chou\u00e9 :', e.message);
    }
  }, delai);
}

async function verifierSeuils() {
  const pct = (state.stockRestant / state.stockTotal) * 100;
  const duree = state.heureDebut ? formatDuree(Date.now() - state.heureDebut) : '?';
  const vendues = state.stockTotal - state.stockRestant;

  if (!state.seuil50envoye && pct <= 50) {
    state.seuil50envoye = true;
    sauvegarderEtat();
    const msg = '\ud83d\udfe1 *Mi-parcours !*\n\n*' + vendues + ' bouteilles* vendues en ' + duree + ' !\nIl reste encore *' + state.stockRestant + ' bouteilles* disponibles.\n\nD\u00e9p\u00eachez-vous... \u23f0';
    try { await whatsappClient.sendMessage(GROUPE_ID, msg); console.log('\u2705 Message 50% envoy\u00e9'); }
    catch (e) { console.log('\u26a0\ufe0f Erreur 50% :', e.message); }
  }

  if (!state.seuil20envoye && pct <= 20) {
    state.seuil20envoye = true;
    sauvegarderEtat();
    const msg = '\ud83d\udd34 *Plus que ' + state.stockRestant + ' bouteilles !*\n\nOn a \u00e9coul\u00e9 *' + vendues + ' bouteilles* en ' + duree + '...\nC\u2019est le moment ou jamais ! \ud83c\udf77';
    try { await whatsappClient.sendMessage(GROUPE_ID, msg); console.log('\u2705 Message 20% envoy\u00e9'); }
    catch (e) { console.log('\u26a0\ufe0f Erreur 20% :', e.message); }
  }
}

async function sequenceSoldOut() {
  const duree = state.heureDebut ? formatDuree(Date.now() - state.heureDebut) : '?';
  const vendues = state.stockTotal;
  const nbCommandes = state.commandes.length;
  console.log('\n\ud83d\udd34 SOLD OUT !');

  if (fs.existsSync(STICKER_FILE)) {
    try {
      const media = MessageMedia.fromFilePath(STICKER_FILE);
      await whatsappClient.sendMessage(GROUPE_ID, media, { sendMediaAsSticker: true });
      console.log('\u2705 Sticker envoy\u00e9');
    } catch (e) {
      await whatsappClient.sendMessage(GROUPE_ID, '\ud83d\udd34 *SOLD OUT !*');
    }
  } else {
    await whatsappClient.sendMessage(GROUPE_ID, '\ud83d\udd34 *SOLD OUT !*');
  }

  setTimeout(async () => {
    const fin = '\ud83d\udd25 *SOLD OUT en ' + duree + '* \u26a1\n\n*Un \u00e9norme merci \u00e0 tous* \ud83d\ude4f\nVous avez \u00e9t\u00e9 ultra rapides... (et vous avez bien fait \ud83d\ude0f)\n\n\ud83d\udce6 *' + vendues + ' bouteilles* vendues\n\ud83d\udc65 *' + nbCommandes + ' commandes* enregistr\u00e9es\n\nVous serez contact\u00e9s prochainement pour les modalit\u00e9s de retrait. \ud83c\udf77';
    try { await whatsappClient.sendMessage(GROUPE_ID, fin); console.log('\u2705 Message fin envoy\u00e9'); }
    catch (e) { console.log('\u26a0\ufe0f Erreur fin :', e.message); }
  }, DELAI_MERCI);
}

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

app.post('/api/nouvelle-vente', requireAuth, async (req, res) => {
  const { vin, description, stock } = req.body;
  if (!vin || !stock || stock <= 0) return res.status(400).json({ error: 'Invalide' });

  state = etatInitial();
  state.vin = vin;
  state.description = description || '';
  state.stockTotal = parseInt(stock);
  state.stockRestant = parseInt(stock);
  state.venteActive = true;
  state.dateVente = new Date().toISOString();
  state.heureDebut = Date.now();
  sauvegarderEtat();
  io.emit('update', state);

  const sep = '\u2500'.repeat(30);
  const instructions = '\n\ud83d\udcdd *Comment commander ?*\n   Envoyez simplement : *X bouteilles* ou *X caisses*\n   Ex\u00b7: "6 bouteilles" \u2014 "1 caisse" \u2014 "3b"\n\ud83d\udc4d Toute commande prise en compte sera like\u0301e automatiquement.';
  const messageVente = '*\u26a1 OFFRE FLASH \u2013 ' + vin + ' \u26a1*\n' + sep + '\n' + (description ? description + '\n' + sep + '\n' : '') + '\ud83d\udce6 *Quantit\u00e9 propos\u00e9e : ' + stock + ' bouteilles*\n' + instructions;

  try {
    await whatsappClient.sendMessage(GROUPE_ID, messageVente);
    console.log('\n\ud83c\udf77 Vente d\u00e9marr\u00e9e : ' + vin);
    res.json({ ok: true });
  } catch (e) {
    console.log('\u26a0\ufe0f Erreur envoi :', e.message);
    res.json({ ok: true, warning: 'Message non envoy\u00e9' });
  }
});

app.post('/api/stopper', requireAuth, (req, res) => {
  state.venteActive = false;
  sauvegarderEtat();
  io.emit('update', state);
  res.json({ ok: true });
});

app.get('/api/export', requireAuth, (req, res) => {
  const totaux = {};
  for (const c of state.commandes) {
    if (!totaux[c.numero]) totaux[c.numero] = { ...c, bouteilles: 0, details: [] };
    totaux[c.numero].bouteilles += c.bouteilles;
    totaux[c.numero].details.push(c.heure + ':' + c.bouteilles + 'b');
  }

  const lines = [
    'Odoo_ID,Numero,Nom,Total_Bouteilles,Total_Caisses,Detail_Commandes,Vin,Date',
    ...Object.values(totaux).map(c => {
      const cl = clientsOdoo[c.numero] || {};
      const caisses = Math.floor(c.bouteilles / 6);
      const reste = c.bouteilles % 6;
      return '"' + (cl.odoo_id || '') + '","+' + c.numero + '","' + (cl.nom || c.nom || '') + '",' +
        c.bouteilles + ',"' + caisses + 'c' + (reste > 0 ? ' +' + reste + 'b' : '') + '","' +
        c.details.join(' | ') + '","' + state.vin + '","' + state.dateVente.slice(0, 10) + '"';
    })
  ];

  const csv = '\uFEFF' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="vente_' + state.dateVente.slice(0, 10) + '.csv"');
  res.send(csv);
});

let whatsappClient;

function demarrerWhatsApp() {
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
    console.log('\n\u2705 Bot connect\u00e9 ! Num\u00e9ro :', whatsappClient.info.wid.user);
    console.log('\ud83c\udf10 Dashboard : http://localhost:' + PORT + '\n');
    io.emit('whatsapp_ready');
  });

  whatsappClient.on('message', async msg => {
    if (msg.fromMe) return;

    // ── MODE DEBUG ──────────────────────────────────────────
    // Decommentes pour trouver l'ID de ton groupe :
    // console.log('👁 MSG DE :', msg.from, '|', msg.body.slice(0, 50));
    // ────────────────────────────────────────────────────────

    if (msg.type === 'sticker' && msg.hasMedia && !fs.existsSync(STICKER_FILE)) {
      try {
        const media = await msg.downloadMedia();
        fs.writeFileSync(STICKER_FILE, Buffer.from(media.data, 'base64'));
        console.log('\u2705 Sticker captur\u00e9 !');
      } catch (e) { console.log('\u26a0\ufe0f Sticker erreur :', e.message); }
      return;
    }

    if (!state.venteActive) return;

    const estDuGroupe = msg.from === GROUPE_ID;
    const estMessagePrive = !msg.from.includes('@g.us');
    if (!estDuGroupe && !estMessagePrive) return;

    const quantite = parseCommande(msg.body);
    if (!quantite) return;

    const numeroContact = await getNumeroReel(msg);
    const nom = (msg._data && msg._data.notifyName) || (clientsOdoo[numeroContact] && clientsOdoo[numeroContact].nom) || '';

    if (state.stockRestant <= 0) {
      console.log('\u274c Stock \u00e9puis\u00e9 \u2013 commande de ' + numeroContact + ' ignor\u00e9e');
      return;
    }

    const qteFinale = Math.min(quantite, state.stockRestant);

    const commande = {
      heure: new Date().toLocaleTimeString('fr-BE'),
      numero: numeroContact, nom: nom, bouteilles: qteFinale,
      odoo_id: (clientsOdoo[numeroContact] && clientsOdoo[numeroContact].odoo_id) || null,
      source: estDuGroupe ? 'groupe' : 'priv\u00e9',
      msgOriginal: msg.body
    };

    state.commandes.push(commande);
    state.stockRestant -= qteFinale;
    sauvegarderEtat();

    io.emit('update', state);
    io.emit('nouvelle_commande', commande);

    // ✅ Like avec delai aleatoire entre 1 et 3 secondes — non-bloquant
    likeAvecDelai(msg);

    console.log('\u2705 [' + commande.heure + '] ' + (nom || numeroContact) + ' (' + commande.source + ') \u2192 +' + qteFinale + 'b | Restant : ' + state.stockRestant);

    await verifierSeuils();

    if (state.stockRestant === 0) {
      state.venteActive = false;
      sauvegarderEtat();
      io.emit('sold_out');
      await sequenceSoldOut();
    }
  });

  whatsappClient.on('disconnected', () => {
    console.log('\u26a0\ufe0f WhatsApp d\u00e9connect\u00e9.');
    io.emit('whatsapp_disconnected');
  });

  whatsappClient.initialize();
}

server.listen(PORT, () => {
  console.log('\u23f3 D\u00e9marrage...');
  demarrerWhatsApp();
});
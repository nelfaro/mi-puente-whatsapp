const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const FormData = require('form-data');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// VARIABLES
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://neogen-n8n-n8n.8fevsr.easypanel.host/webhook/whatsapp-entrada';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'WhatsApp-Principal';
const SESSION_FOLDER = `./session_${INSTANCE_NAME.replace(/\s+/g, '_')}`;

let qrCodeData = null;
let connectionStatus = "Iniciando...";
let userNumber = null;
let sock = null;

// --- 1. ARRANCAMOS EL SERVIDOR WEB PRIMERO (Para evitar SIGTERM de Easypanel) ---
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Servidor Web de ${INSTANCE_NAME} listo en puerto ${PORT}`);
    startWhatsApp(); // Iniciamos WhatsApp después de que el puerto ya esté abierto
});

async function startWhatsApp() {
    console.log(`> Conectando a WhatsApp...`);
    
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            connectionStatus = "Esperando Escaneo";
            QRCode.toDataURL(qr, (err, url) => { qrCodeData = url; });
            qrcodeTerminal.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            qrCodeData = null;
            userNumber = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Conexión cerrada. Razón: ${statusCode}. Reconectar: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                connectionStatus = "Reconectando...";
                setTimeout(() => startWhatsApp(), 5000);
            } else {
                connectionStatus = "Sesión Cerrada";
                if (fs.existsSync(SESSION_FOLDER)) fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                setTimeout(() => startWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            connectionStatus = "Conectado";
            qrCodeData = null;
            userNumber = sock.user.id.split(':')[0];
            console.log(`✅ INSTANCIA CONECTADA: ${userNumber}`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.message) {
            const isAudio = !!msg.message.audioMessage;
            const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;

            const formData = new FormData();
            formData.append('instance', INSTANCE_NAME);
            formData.append('sender', msg.key.remoteJid);
            formData.append('nombre', msg.pushName || 'Contacto');

            if (isAudio) {
                try {
                    console.log("Procesando audio...");
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    formData.append('file', buffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
                    formData.append('texto', '[[AUDIO_MESSAGE]]');
                } catch (err) {
                    console.error("Error descargando audio:", err.message);
                    return;
                }
            } else if (texto) {
                formData.append('texto', texto);
            } else {
                return; 
            }

            try {
                await axios.post(N8N_WEBHOOK_URL, formData, {
                    headers: { ...formData.getHeaders() }
                });
            } catch (e) {
                console.error("Error n8n:", e.message);
            }
        }
    });
}

// ENDPOINTS
app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeData, number: userNumber }));

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Panel ${INSTANCE_NAME}</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; background: #f4f7f6; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .card { background: white; padding: 2rem; border-radius: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); text-align: center; width: 90%; max-width: 400px; }
                .status-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; margin-right: 8px; }
                .connected-icon { font-size: 4rem; color: #25D366; margin-bottom: 10px; }
                img { width: 250px; margin: 1rem 0; border: 1px solid #ddd; padding: 10px; border-radius: 10px; }
                .btn { color: white; border: none; padding: 12px 25px; border-radius: 10px; cursor: pointer; font-size: 1rem; width: 100%; transition: 0.3s; margin-top: 15px; text-decoration: none; display: block; }
                .btn-red { background: #FF3B30; } .btn-blue { background: #007AFF; }
                .hidden { display: none; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>${INSTANCE_NAME}</h1>
                <div id="status-container" style="font-weight:bold; margin-bottom:20px;">Cargando...</div>
                <div id="qr-container" class="hidden"><p>Escanea el QR:</p><img id="qr-img" src=""></div>
                <div id="connected-container" class="hidden"><div class="connected-icon">✅</div><p>Vínculo:</p><div id="phone-number" style="font-size:1.2rem; font-weight:bold;"></div></div>
                <form action="/logout" method="POST" onsubmit="return confirm('¿Desconectar?')"><button id="action-btn" class="btn btn-blue" type="submit">Reiniciar</button></form>
            </div>
            <script>
                async function updateStatus() {
                    try {
                        const res = await fetch('/status');
                        const data = await res.json();
                        const statusContainer = document.getElementById('status-container');
                        const qrContainer = document.getElementById('qr-container');
                        const connectedContainer = document.getElementById('connected-container');
                        const actionBtn = document.getElementById('action-btn');
                        statusContainer.innerHTML = '<span class="status-dot" style="background:' + (data.status === 'Conectado' ? '#25D366' : '#FF3B30') + '"></span>' + data.status;
                        if (data.status === 'Conectado') {
                            connectedContainer.classList.remove('hidden'); qrContainer.classList.add('hidden');
                            document.getElementById('phone-number').innerText = '+' + data.number;
                            actionBtn.innerText = 'Desconectar'; actionBtn.className = 'btn btn-red';
                        } else if (data.qr) {
                            qrContainer.classList.remove('hidden'); connectedContainer.classList.add('hidden');
                            document.getElementById('qr-img').src = data.qr;
                            actionBtn.innerText = 'Nuevo QR'; actionBtn.className = 'btn btn-blue';
                        }
                    } catch (e) {}
                }
                setInterval(updateStatus, 2000);
                updateStatus();
            </script>
        </body>
        </html>
    `);
});

app.post('/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
    } catch(e) {}
    if (fs.existsSync(SESSION_FOLDER)) fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
    setTimeout(() => startWhatsApp(), 2000);
    res.send('<script>window.location.href="/";</script>');
});

app.post('/send', async (req, res) => {
    const { jid, message } = req.body;
    try {
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://neogen-n8n-n8n.8fevsr.easypanel.host/webhook/whatsapp-entrada';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'WhatsApp-Principal';
const SESSION_FOLDER = `./session_${INSTANCE_NAME.replace(/\s+/g, '_')}`;

let qrCodeData = null;
let connectionStatus = "Desconectado";
let userNumber = null;
let sock = null;

async function startWhatsApp() {
    console.log(`\n> Iniciando Instancia: [${INSTANCE_NAME}]`);
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
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
            connectionStatus = "Desconectado";
            qrCodeData = null;
            userNumber = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => startWhatsApp(), 3000);
            } else {
                if (fs.existsSync(SESSION_FOLDER)) {
                    fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                }
                setTimeout(() => startWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            connectionStatus = "Conectado";
            qrCodeData = null;
            // Extraer el número de teléfono conectado
            const id = sock.user.id.split(':')[0];
            userNumber = id;
            console.log(`✅ [${INSTANCE_NAME}] CONECTADO: ${userNumber}`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.message && N8N_WEBHOOK_URL) {
            const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (texto) {
                try {
                    await axios.post(N8N_WEBHOOK_URL, { 
                        instance: INSTANCE_NAME,
                        sender: msg.key.remoteJid,
                        nombre: msg.pushName || 'Contacto',
                        texto: texto
                    });
                } catch (e) { console.error("Error n8n"); }
            }
        }
    });
}

// API PARA QUE LA UI SEPA EL ESTADO EN TIEMPO REAL
app.get('/status', (req, res) => {
    res.json({
        status: connectionStatus,
        qr: qrCodeData,
        number: userNumber
    });
});

// INTERFAZ WEB
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
                .status-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; margin-right: 5px; }
                .Connected { color: #25D366; } .Disconnected, .Esperando { color: #FF3B30; }
                .connected-icon { font-size: 4rem; color: #25D366; margin-bottom: 10px; }
                img { width: 250px; margin: 1rem 0; border: 1px solid #ddd; padding: 10px; border-radius: 10px; }
                .btn { color: white; border: none; padding: 12px 25px; border-radius: 10px; cursor: pointer; font-size: 1rem; width: 100%; transition: 0.3s; margin-top: 15px; }
                .btn-red { background: #FF3B30; } .btn-blue { background: #007AFF; }
                .hidden { display: none; }
                #phone-number { font-size: 1.1rem; font-weight: bold; color: #444; margin: 10px 0; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1 style="margin-top:0">${INSTANCE_NAME}</h1>
                <div id="status-container" class="status">Cargando...</div>
                
                <div id="qr-container" class="hidden">
                    <p>Escanea el código QR:</p>
                    <img id="qr-img" src="">
                </div>

                <div id="connected-container" class="hidden">
                    <div class="connected-icon">✅</div>
                    <p>Dispositivo vinculado:</p>
                    <div id="phone-number"></div>
                </div>

                <div id="loading-container">
                    <p>Iniciando servicio...</p>
                </div>

                <form action="/logout" method="POST" onsubmit="return confirm('¿Confirmar acción?')">
                    <button id="action-btn" class="btn" type="submit">Cargando...</button>
                </form>
            </div>

            <script>
                async function updateStatus() {
                    try {
                        const res = await fetch('/status');
                        const data = await res.json();
                        
                        const statusContainer = document.getElementById('status-container');
                        const qrContainer = document.getElementById('qr-container');
                        const connectedContainer = document.getElementById('connected-container');
                        const loadingContainer = document.getElementById('loading-container');
                        const actionBtn = document.getElementById('action-btn');
                        const qrImg = document.getElementById('qr-img');
                        const phoneDisplay = document.getElementById('phone-number');

                        statusContainer.innerHTML = '<span class="status-dot" style="background:' + (data.status === 'Conectado' ? '#25D366' : '#FF3B30') + '"></span>' + data.status;
                        statusContainer.className = 'status ' + data.status;

                        if (data.status === 'Conectado') {
                            connectedContainer.classList.remove('hidden');
                            qrContainer.classList.add('hidden');
                            loadingContainer.classList.add('hidden');
                            phoneDisplay.innerText = '+' + data.number;
                            actionBtn.innerText = 'Desconectar WhatsApp';
                            actionBtn.className = 'btn btn-red';
                        } else if (data.qr) {
                            qrContainer.classList.remove('hidden');
                            connectedContainer.classList.add('hidden');
                            loadingContainer.classList.add('hidden');
                            qrImg.src = data.qr;
                            actionBtn.innerText = 'Reiniciar / Nuevo QR';
                            actionBtn.className = 'btn btn-blue';
                        } else {
                            loadingContainer.classList.remove('hidden');
                            qrContainer.classList.add('hidden');
                            connectedContainer.classList.add('hidden');
                            actionBtn.innerText = 'Reiniciar Servicio';
                            actionBtn.className = 'btn btn-blue';
                        }
                    } catch (e) { console.error("Error actualizando status"); }
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
        if (sock) sock.end();
        if (fs.existsSync(SESSION_FOLDER)) {
            fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
        }
        setTimeout(() => startWhatsApp(), 2000);
        res.send('<script>window.location.href="/";</script>');
    } catch (e) { res.send('Error.'); }
});

app.post('/send', async (req, res) => {
    const { jid, message } = req.body;
    try {
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

startWhatsApp();
app.listen(PORT, "0.0.0.0");

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CONFIGURACIÓN POR VARIABLES DE ENTORNO
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://neogen-n8n-n8n.8fevsr.easypanel.host/webhook/whatsapp-entrada';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'WhatsApp-Principal';
const SESSION_FOLDER = `session_${INSTANCE_NAME.replace(/\s+/g, '_')}`;

let qrCodeData = null;
let connectionStatus = "Desconectado";
let sock = null;

async function startWhatsApp() {
    console.log(`> Iniciando Instancia: [${INSTANCE_NAME}]`);
    
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            // Generar QR para Web
            QRCode.toDataURL(qr, (err, url) => { qrCodeData = url; });
            // Generar QR para Terminal (Debug)
            qrcodeTerminal.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            connectionStatus = "Desconectado";
            qrCodeData = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Conexión cerrada en ${INSTANCE_NAME}. Reintentando: ${shouldReconnect}`);
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            connectionStatus = "Conectado";
            qrCodeData = null;
            console.log(`✅ [${INSTANCE_NAME}] CONECTADO`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.message) {
            const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (texto && N8N_WEBHOOK_URL) {
                try {
                    await axios.post(N8N_WEBHOOK_URL, { 
                        instance: INSTANCE_NAME,
                        sender: msg.key.remoteJid,
                        nombre: msg.pushName || 'Contacto',
                        texto: texto
                    });
                } catch (e) { console.error("Error enviando a n8n"); }
            }
        }
    });
}

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
                .status { font-size: 1.2rem; font-weight: bold; margin-bottom: 1rem; color: ${connectionStatus === 'Conectado' ? '#25D366' : '#FF3B30'}; }
                img { width: 250px; margin: 1rem 0; border: 1px solid #ddd; padding: 10px; border-radius: 10px; }
                .btn { background: #FF3B30; color: white; border: none; padding: 12px 25px; border-radius: 10px; cursor: pointer; font-size: 1rem; width: 100%; transition: 0.3s; }
                .refresh { font-size: 0.8rem; color: #888; margin-top: 1rem; cursor: pointer; text-decoration: underline; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>${INSTANCE_NAME}</h1>
                <div class="status">● ${connectionStatus}</div>
                ${qrCodeData ? `<div>Escanea el QR con tu WhatsApp:</div><img src="${qrCodeData}">` : ''}
                ${connectionStatus === 'Conectado' ? `<p>✅ WhatsApp vinculado correctamente.</p>` : qrCodeData ? '' : '<p>Generando código QR...</p>'}
                <form action="/logout" method="POST" onsubmit="return confirm('¿Desconectar este dispositivo?')">
                    <button class="btn" type="submit">Desconectar WhatsApp</button>
                </form>
                <div class="refresh" onclick="location.reload()">Actualizar Estado</div>
            </div>
        </body>
        </html>
    `);
});

app.post('/logout', async (req, res) => {
    try {
        await sock.logout();
        res.send('<script>alert("Sesión cerrada"); window.location.href="/";</script>');
    } catch (e) { res.send('Error al cerrar sesión.'); }
});

app.post('/send', async (req, res) => {
    const { jid, message } = req.body;
    try {
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent', instance: INSTANCE_NAME });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

startWhatsApp();
app.listen(PORT, "0.0.0.0", () => console.log(`Servidor en puerto ${PORT}`));

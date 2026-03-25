const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage, 
    fetchLatestBaileysVersion, 
    Browsers 
} = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');

const app = express();
app.use(express.json());

// --- CONFIGURACIÓN ---
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://neogen-n8n-n8n.8fevsr.easypanel.host/webhook/whatsapp-entrada';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'WhatsApp-Principal';
const SESSION_FOLDER = '/app/auth_info'; 

let qrCodeData = null;
let connectionStatus = "Desconectado";
let userNumber = null;
let sock = null;

function clearSessionFiles() {
    if (fs.existsSync(SESSION_FOLDER)) {
        console.log("🧹 Limpiando archivos de sesión antiguos para resolver conflictos...");
        const files = fs.readdirSync(SESSION_FOLDER);
        for (const file of files) {
            try {
                const filePath = path.join(SESSION_FOLDER, file);
                fs.rmSync(filePath, { recursive: true, force: true });
            } catch (e) {
                console.log(`⚠️ No se pudo borrar ${file}: ${e.message}`);
            }
        }
    }
}

async function startWhatsApp() {
    console.log(`\n🚀 Iniciando instancia: ${INSTANCE_NAME}`);
    
    try {
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`> Conectando con versión de WhatsApp Web v${version.join('.')} (Latest: ${isLatest})`);

        if (!fs.existsSync(SESSION_FOLDER)) {
            fs.mkdirSync(SESSION_FOLDER, { recursive: true });
        }
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'error' }),
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            generateHighQualityLinkPreview: true,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionStatus = "Esperando Escaneo";
                qrCodeData = await QRCode.toDataURL(qr);
                console.log("✨ Nuevo código QR generado.");
            }

            if (connection === 'close') {
                qrCodeData = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`⚠️ Conexión cerrada. Código de estado: ${statusCode}`);

                const sessionErrors = [DisconnectReason.loggedOut, 401, 403, 405, 440];

                if (sessionErrors.includes(statusCode)) {
                    console.log("💥 Error crítico detectado. Reiniciando sesión completa...");
                    connectionStatus = "Sesión Expirada";
                    clearSessionFiles();
                    setTimeout(() => startWhatsApp(), 5000);
                } else {
                    console.log("Reintentando conexión automática en 5 segundos...");
                    setTimeout(() => startWhatsApp(), 5000);
                }
            } else if (connection === 'open') {
                console.log(`✅ ¡CONECTADO EXITOSAMENTE!`);
                connectionStatus = "Conectado";
                qrCodeData = null;
                userNumber = sock.user.id.split(':')[0];
            }
        });

        // RECEPCIÓN DE MENSAJES
        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.key.fromMe && msg.message) {
                const m = msg.message;
                const texto = m.conversation || m.extendedTextMessage?.text;
                const multimedia = m.audioMessage || m.imageMessage || m.documentMessage;

                const formData = new FormData();
                formData.append('instance', INSTANCE_NAME);
                formData.append('sender', msg.key.remoteJid);
                formData.append('nombre', msg.pushName || 'Contacto');

                // --- NUEVOS CAMPOS AGREGADOS ---
                formData.append('messageTimestamp', msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now());
                formData.append('messageId', msg.key.id);
                formData.append('fromMe', msg.key.fromMe);
                // --------------------------------

                if (multimedia) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        let filename = m.audioMessage ? 'audio.ogg' : 
                                       m.imageMessage ? 'imagen.jpg' : 
                                       (m.documentMessage.fileName || 'archivo');
                        let mimetype = m.audioMessage ? 'audio/ogg' : 
                                       m.imageMessage ? 'image/jpeg' : 
                                       (m.documentMessage.mimetype || 'application/octet-stream');
                        
                        formData.append('file', buffer, { filename, contentType: mimetype });
                        formData.append('texto', '[[ARCHIVO_MULTIMEDIA]]');
                    } catch (e) { 
                        console.error("Error descargando media:", e.message); 
                    }
                } else if (texto) {
                    formData.append('texto', texto);
                } else { 
                    return; 
                }

                axios.post(N8N_WEBHOOK_URL, formData, { headers: formData.getHeaders() }).catch(e => {});
            }
        });

    } catch (error) {
        console.error("❌ Fallo al iniciar WhatsApp:", error);
        setTimeout(() => startWhatsApp(), 10000);
    }
}

// --- SERVIDOR EXPRESS ---
app.get('/status', (req, res) => 
    res.json({ status: connectionStatus, qr: qrCodeData, number: userNumber })
);

app.post('/send', async (req, res) => {
    const { jid, message } = req.body;
    try {
        if (!sock) return res.status(500).json({ error: "Servicio no listo" });
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent' });
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Servidor Web listo en puerto ${PORT}`);
    startWhatsApp();
});

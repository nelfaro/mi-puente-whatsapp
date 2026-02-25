const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://neogen-n8n-n8n.8fevsr.easypanel.host/webhook/whatsapp-entrada';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'WhatsApp-Principal';
const SESSION_FOLDER = '/app/auth_info'; 

let qrCodeData = null;
let connectionStatus = "Desconectado";
let userNumber = null;
let sock = null;

// FUNCIÓN DE LIMPIEZA SEGURA: Solo borra archivos, nunca la carpeta raíz
function safeClearSession() {
    console.log("🧹 Iniciando limpieza de seguridad de la sesión...");
    if (fs.existsSync(SESSION_FOLDER)) {
        const files = fs.readdirSync(SESSION_FOLDER);
        for (const file of files) {
            try {
                const filePath = path.join(SESSION_FOLDER, file);
                if (fs.lstatSync(filePath).isDirectory()) {
                    fs.rmSync(filePath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(filePath);
                }
            } catch (err) {
                console.log(`⚠️ No se pudo borrar ${file} (quizás está en uso), ignorando...`);
            }
        }
    }
}

async function startWhatsApp() {
    console.log(`\n🚀 Conectando a WhatsApp: ${INSTANCE_NAME}...`);
    
    // Si la carpeta no existe, la creamos para evitar errores de inicio
    if (!fs.existsSync(SESSION_FOLDER)) {
        fs.mkdirSync(SESSION_FOLDER, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }),
        printQRInTerminal: false,
        browser: ['Chrome (Linux)', 'Academia', '1.0'],
        connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            connectionStatus = "Esperando Escaneo";
            qrCodeData = await QRCode.toDataURL(qr);
            console.log("✨ Código QR generado. Listo en la UI.");
        }

        if (connection === 'close') {
            qrCodeData = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Conexión cerrada. Código: ${statusCode}`);

            // Errores que indican que la sesión ya no sirve para nada
            const fatalErrors = [DisconnectReason.loggedOut, 401, 403, 405, 411, 440];

            if (fatalErrors.includes(statusCode)) {
                console.log("💥 Error irrecuperable. Limpiando y reiniciando de cero...");
                connectionStatus = "Sesión Expirada";
                safeClearSession();
                // En lugar de process.exit, simplemente reiniciamos la función tras un breve delay
                setTimeout(() => startWhatsApp(), 5000);
            } else {
                console.log("Intentando reconectar automáticamente...");
                setTimeout(() => startWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log(`✅ CONEXIÓN EXITOSA`);
            connectionStatus = "Conectado";
            qrCodeData = null;
            userNumber = sock.user.id.split(':')[0];
        }
    });

    // Lógica de mensajes
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
            if (multimedia) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    formData.append('file', buffer, { filename: 'archivo', contentType: 'application/octet-stream' });
                    formData.append('texto', '[[ARCHIVO_MULTIMEDIA]]');
                } catch (e) { console.log("Error descargando media"); }
            } else if (texto) {
                formData.append('texto', texto);
            } else { return; }
            axios.post(N8N_WEBHOOK_URL, formData, { headers: formData.getHeaders() }).catch(e => {});
        }
    });
}

// --- SERVIDOR WEB ---
// Iniciamos el servidor ANTES que WhatsApp para que Easypanel no de timeout
app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeData, number: userNumber }));
app.get('/', (req, res) => res.send("OK"));
app.post('/logout', (req, res) => {
    safeClearSession();
    connectionStatus = "Desconectado";
    setTimeout(() => startWhatsApp(), 2000);
    res.send("Sesión reiniciada");
});
app.post('/send', async (req, res) => {
    const { jid, message } = req.body;
    try {
        if (!sock) return res.status(500).json({ error: "No conectado" });
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Servidor Web escuchando en puerto ${PORT}`);
    // Pequeño delay para asegurar que el servidor web responda antes de saturar el CPU con WhatsApp
    setTimeout(() => startWhatsApp(), 2000);
});

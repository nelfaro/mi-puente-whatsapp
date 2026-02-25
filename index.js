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
const SESSION_FOLDER = './auth_info';

let qrCodeData = null;
let connectionStatus = "Desconectado";
let userNumber = null;
let sock = null;

// Función para vaciar la carpeta sin borrarla (para evitar el error EBUSY de Docker)
function clearSession() {
    if (fs.existsSync(SESSION_FOLDER)) {
        console.log("🧹 Vaciando archivos de sesión corruptos...");
        fs.readdirSync(SESSION_FOLDER).forEach(file => {
            try {
                fs.unlinkSync(path.join(SESSION_FOLDER, file));
            } catch (e) {
                console.log(`No se pudo borrar ${file}, probablemente en uso.`);
            }
        });
    }
}

async function startWhatsApp() {
    console.log(`\n🚀 Intentando iniciar instancia: ${INSTANCE_NAME}`);
    
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }), // Solo errores críticos para no ensuciar el log
        printQRInTerminal: false,
        browser: ['Chrome (Linux)', 'Academia', '1.0'] // Identificador de navegador
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("✨ Nuevo QR generado. Listando en la UI...");
            connectionStatus = "Esperando Escaneo";
            qrCodeData = await QRCode.toDataURL(qr);
        }

        if (connection === 'close') {
            qrCodeData = null;
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode;
            
            console.log(`⚠️ Conexión cerrada. Motivo: ${statusCode}`);
            
            // Si la sesión ya no sirve, limpiamos todo
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log("❌ Sesión inválida/cerrada. Limpiando datos...");
                connectionStatus = "Sesión Inválida";
                clearSession();
                setTimeout(() => startWhatsApp(), 5000);
            } else {
                console.log("Reintentando conexión en 5 segundos...");
                setTimeout(() => startWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log(`✅ CONECTADO EXITOSAMENTE`);
            connectionStatus = "Conectado";
            qrCodeData = null;
            userNumber = sock.user.id.split(':')[0];
        }
    });

    // Lógica de mensajes (se mantiene igual)
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
                } catch (e) {}
            } else if (texto) { formData.append('texto', texto); }
            else { return; }
            axios.post(N8N_WEBHOOK_URL, formData, { headers: formData.getHeaders() }).catch(e => {});
        }
    });
}

// Servidor Express (Endpoints)
app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeData, number: userNumber }));
app.get('/', (req, res) => res.send("Servidor Activo. Ve a /status para ver el estado o usa la UI."));
app.post('/logout', async (req, res) => {
    console.log("Cerrando sesión solicitado...");
    clearSession();
    if (sock) try { await sock.logout(); } catch(e) {}
    res.send('<script>window.location.href="/";</script>');
});
app.post('/send', async (req, res) => {
    const { jid, message } = req.body;
    try {
        if (!sock) return res.status(500).json({ error: "WhatsApp no conectado" });
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Servidor Web listo en puerto ${PORT}`);
    startWhatsApp();
});

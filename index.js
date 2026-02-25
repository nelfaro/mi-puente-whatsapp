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

// Función para vaciar la carpeta (evita EBUSY al no borrar la carpeta raíz del volumen)
function clearSession() {
    if (fs.existsSync(SESSION_FOLDER)) {
        console.log("🧹 Limpiando archivos de sesión conflictivos (Error 405)...");
        const files = fs.readdirSync(SESSION_FOLDER);
        for (const file of files) {
            try {
                const filePath = path.join(SESSION_FOLDER, file);
                if (fs.lstatSync(filePath).isDirectory()) {
                    fs.rmSync(filePath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(filePath);
                }
            } catch (e) {
                console.log(`No se pudo borrar ${file}: ${e.message}`);
            }
        }
    }
}

async function startWhatsApp() {
    console.log(`\n🚀 Intentando iniciar instancia: ${INSTANCE_NAME}`);
    
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'error' }),
        printQRInTerminal: false,
        browser: ['Chrome (Linux)', 'Academia', '1.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("✨ Nuevo QR generado satisfactoriamente.");
            connectionStatus = "Esperando Escaneo";
            qrCodeData = await QRCode.toDataURL(qr);
        }

        if (connection === 'close') {
            qrCodeData = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            console.log(`⚠️ Conexión cerrada. Código de estado: ${statusCode}`);
            
            // EL CAMBIO CLAVE: Incluir 405, 403 y otros fallos críticos
            const logicErrors = [DisconnectReason.loggedOut, 401, 403, 405, 440];
            
            if (logicErrors.includes(statusCode)) {
                console.log("❌ Sesión irrecuperable detectada. Reseteando archivos...");
                connectionStatus = "Sesión Expirada";
                clearSession();
                // Esperamos un poco para que el sistema de archivos se libere
                setTimeout(() => startWhatsApp(), 5000);
            } else {
                console.log("Reintentando conexión automática...");
                connectionStatus = "Reconectando";
                setTimeout(() => startWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log(`✅ CONECTADO EXITOSAMENTE`);
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
                } catch (e) {}
            } else if (texto) { formData.append('texto', texto); }
            else { return; }
            axios.post(N8N_WEBHOOK_URL, formData, { headers: formData.getHeaders() }).catch(e => {});
        }
    });
}

// Endpoints y Servidor
app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeData, number: userNumber }));
app.get('/', (req, res) => res.send("Puente Activo"));
app.post('/logout', (req, res) => { clearSession(); res.send("OK"); process.exit(0); });
app.post('/send', async (req, res) => {
    const { jid, message } = req.body;
    try {
        if (!sock) return res.status(500).json({ error: "WhatsApp no iniciado" });
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Servidor Web en puerto ${PORT}`);
    startWhatsApp();
});

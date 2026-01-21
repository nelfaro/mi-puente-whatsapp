const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const FormData = require('form-data');

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
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) QRCode.toDataURL(qr, (err, url) => { qrCodeData = url; });
        if (connection === 'close') {
            connectionStatus = "Desconectado";
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) setTimeout(() => startWhatsApp(), 3000);
        } else if (connection === 'open') {
            connectionStatus = "Conectado";
            userNumber = sock.user.id.split(':')[0];
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
                console.log("Descargando audio...");
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                formData.append('file', buffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
                formData.append('texto', '[[AUDIO_MESSAGE]]');
            } else if (texto) {
                formData.append('texto', texto);
            } else {
                return; // Ignorar otros tipos de mensajes por ahora
            }

            try {
                await axios.post(N8N_WEBHOOK_URL, formData, {
                    headers: { ...formData.getHeaders() }
                });
                console.log("Enviado a n8n correctamente");
            } catch (e) {
                console.error("Error enviando a n8n:", e.message);
            }
        }
    });
}

app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeData, number: userNumber }));
app.get('/', (req, res) => res.send("Servidor Activo"));
app.post('/logout', async (req, res) => { /* lógica de logout */ });
app.post('/send', async (req, res) => {
    const { jid, message } = req.body;
    try {
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

startWhatsApp();
app.listen(PORT, "0.0.0.0");

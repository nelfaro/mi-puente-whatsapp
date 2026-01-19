const { default: makeWASocket, useMultiFileAuthState, disconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');

const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true // Esto mostrará el QR en los logs de Easypanel
    });

    sock.ev.on('creds.update', saveCreds);

    // 1. Recibir mensajes de WhatsApp y enviarlos a n8n
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.message) {
            const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (texto) {
                console.log("Nuevo mensaje recibido, enviando a n8n...");
                try {
                    await axios.post('https://neogen-n8n-chatwoot.8fevsr.easypanel.host/', {
                        sender: msg.key.remoteJid,
                        name: msg.pushName,
                        text: texto
                    });
                } catch (e) { console.error("Error enviando a n8n"); }
            }
        }
    });

    // 2. Servidor para que n8n le pida a este puente enviar mensajes
    app.post('/send', async (req, res) => {
        const { jid, message } = req.body;
        try {
            await sock.sendMessage(jid, { text: message });
            res.status(200).json({ status: 'sent' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== disconnectReason.loggedOut;
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            console.log('CONECTADO A WHATSAPP EXITOSAMENTE');
        }
    });
}

app.listen(port, () => {
    console.log(`Servidor de comandos escuchando en puerto ${port}`);
    startWhatsApp();
});
const { default: makeWASocket, useMultiFileAuthState, disconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const qrcode = require('qrcode-terminal'); // Esta es la pieza clave

const app = express();
app.use(express.json());
const port = 3000; 

async function startWhatsApp() {
    console.log("Iniciando conexión con WhatsApp...");
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), // Silenciamos logs internos para ver mejor el QR
        printQRInTerminal: false // Lo ponemos en false porque lo haremos nosotros manualmente
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ESTA PARTE DIBUJA EL QR
        if (qr) {
            console.log("========================================");
            console.log("ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP:");
            console.log("========================================");
            qrcode.generate(qr, { small: true });
            console.log("========================================");
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== disconnectReason.loggedOut;
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            console.log('¡CONECTADO A WHATSAPP EXITOSAMENTE!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.message) {
            const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (texto) {
                console.log("Mensaje de " + msg.pushName + ": " + texto);
                try {
                    // Cambia esta URL por la de tu n8n cuando la tengas
                    await axios.post('https://neogen-n8n-chatwoot.8fevsr.easypanel.host', { 
                        sender: msg.key.remoteJid,
                        nombre: msg.pushName,
                        texto: texto
                    });
                } catch (e) { /* Error silencioso si n8n no responde */ }
            }
        }
    });

    app.post('/send', async (req, res) => {
        const { jid, message } = req.body;
        try {
            await sock.sendMessage(jid, { text: message });
            res.status(200).json({ status: 'sent' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

app.get('/', (req, res) => res.send('Puente Activo'));

app.listen(port, "0.0.0.0", () => {
    console.log(`Servidor escuchando en puerto ${port}`);
    startWhatsApp().catch(err => console.log("Error inicial:", err));
});

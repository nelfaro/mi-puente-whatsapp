const { default: makeWASocket, useMultiFileAuthState, disconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());
const port = 3000; 

async function startWhatsApp() {
    console.log("Iniciando conexión con WhatsApp...");
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        
        if (connection === 'close') {
            // Arreglo del error TypeError:
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== disconnectReason.loggedOut;
            console.log("Conexión cerrada. ¿Reconectando?:", shouldReconnect);
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
                console.log(`Enviando a n8n mensaje de ${msg.pushName}: ${texto}`);
                try {
                    // ASEGÚRATE DE QUE ESTA URL SEA LA DE TU WEBHOOK DE n8n (PRODUCTION URL)
                    const response = await axios.post('https://neogen-n8n-n8n.8fevsr.easypanel.host/webhook/whatsapp-entrada', { 
                        sender: msg.key.remoteJid,
                        nombre: msg.pushName || 'Contacto de WhatsApp',
                        texto: texto
                    });
                    console.log("Respuesta de n8n:", response.status); 
                } catch (e) { 
                    console.error("ERROR AL ENVIAR A n8n:", e.message); 
                }
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

app.listen(port, "0.0.0.0", () => {
    console.log(`Servidor escuchando en puerto ${port}`);
    startWhatsApp().catch(err => console.log("Error inicial:", err));
});


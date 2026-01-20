const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://neogen-n8n-n8n.8fevsr.easypanel.host/webhook/whatsapp-entrada';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'WhatsApp-Principal';

// --- ESTE ES EL CAMBIO CLAVE ---
// Si no definimos una carpeta en Easypanel, usará una basada en el nombre de la instancia
const SESSION_FOLDER = process.env.SESSION_FOLDER || `session_${INSTANCE_NAME.replace(/\s+/g, '_')}`;

async function startWhatsApp() {
    console.log(`\n> Iniciando Instancia: [${INSTANCE_NAME}]`);
    console.log(`> Carpeta de sesión: ${SESSION_FOLDER}`);
    
    // Usamos la carpeta dinámica
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`\n--- ESCANEA EL QR PARA: ${INSTANCE_NAME} ---`);
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            // Si el error es "loggedOut", significa que la carpeta tiene datos viejos o inválidos
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Conexión cerrada en ${INSTANCE_NAME}. Reintentando: ${shouldReconnect} (Status: ${statusCode})`);
            
            if (shouldReconnect) {
                startWhatsApp();
            } else {
                console.log("❌ Sesión cerrada permanentemente. Debes borrar la carpeta de sesión o el volumen y re-escaneár el QR.");
            }
        } else if (connection === 'open') {
            console.log(`✅ INSTANCIA [${INSTANCE_NAME}] CONECTADA`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.message) {
            const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (texto) {
                try {
                    await axios.post(N8N_WEBHOOK_URL, { 
                        instance: INSTANCE_NAME,
                        sender: msg.key.remoteJid,
                        nombre: msg.pushName || 'Contacto',
                        texto: texto
                    });
                } catch (e) { console.error(`Error n8n: ${e.message}`); }
            }
        }
    });

    app.post('/send', async (req, res) => {
        const { jid, message } = req.body;
        try {
            await sock.sendMessage(jid, { text: message });
            res.status(200).json({ status: 'sent', instance: INSTANCE_NAME });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
}

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor de ${INSTANCE_NAME} escuchando en puerto ${PORT}`);
    startWhatsApp().catch(err => console.log("Error:", err));
});

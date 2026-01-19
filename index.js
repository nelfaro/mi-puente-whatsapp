const { default: makeWASocket, useMultiFileAuthState, disconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');

const app = express();
app.use(express.json());
const port = 3000; 

async function startWhatsApp() {
    console.log("Iniciando conexión con WhatsApp...");
    // Intentará guardar la sesión en la carpeta 'auth_info'
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'info' }), 
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.message) {
            const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (texto) {
                console.log("Mensaje recibido:", texto);
                // Si aún no tienes n8n configurado, esto fallará pero no detendrá la app
                try {
                    await axios.post('https://webhook.site/test', { // Cambia esto por tu n8n luego
                        sender: msg.key.remoteJid,
                        text: texto
                    });
                } catch (e) { console.log("n8n no disponible todavía"); }
            }
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) console.log("NUEVO CÓDIGO QR GENERADO. MIRA LOS LOGS.");
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== disconnectReason.loggedOut;
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            console.log('¡CONECTADO A WHATSAPP EXITOSAMENTE!');
        }
    });

    // Ruta para enviar mensajes desde n8n
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

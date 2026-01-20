const { default: makeWASocket, useMultiFileAuthState, disconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());

// --- CONFIGURACIÓN DE INSTANCIA ---
const PORT = process.env.PORT || 3000;
// Usamos la URL que me pasaste como base, pero permitimos cambiarla desde Easypanel si hace falta
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://neogen-n8n-n8n.8fevsr.easypanel.host/webhook/whatsapp-entrada';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'WhatsApp-Principal';

async function startWhatsApp() {
    console.log(`\n> Iniciando Instancia: [${INSTANCE_NAME}]`);
    
    // Carpeta donde se guarda la sesión (auth_info)
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), // Silenciamos logs internos de Baileys
        printQRInTerminal: false 
    });

    // Guardar credenciales cada vez que se actualicen
    sock.ev.on('creds.update', saveCreds);

    // Gestión de la conexión y QR
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`\n--- ESCANEA EL QR PARA: ${INSTANCE_NAME} ---`);
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== disconnectReason.loggedOut;
            console.log(`Conexión cerrada en ${INSTANCE_NAME}. Reintentando: ${shouldReconnect}`);
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            console.log(`✅ INSTANCIA [${INSTANCE_NAME}] CONECTADA Y LISTA`);
        }
    });

    // RECIBIR MENSAJES Y ENVIAR A n8n
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        
        // No procesar mensajes enviados por nosotros mismos ni mensajes vacíos
        if (!msg.key.fromMe && msg.message) {
            const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
            
            if (texto) {
                console.log(`[${INSTANCE_NAME}] Mensaje de ${msg.pushName}: ${texto}`);
                
                try {
                    // Enviamos los datos a n8n
                    await axios.post(N8N_WEBHOOK_URL, { 
                        instance: INSTANCE_NAME,
                        sender: msg.key.remoteJid,
                        nombre: msg.pushName || 'Contacto de WhatsApp',
                        texto: texto
                    });
                } catch (e) { 
                    console.error(`❌ Error enviando a n8n: ${e.message}`); 
                }
            }
        }
    });

    // ENDPOINT PARA ENVIAR MENSAJES (Para que n8n te responda)
    app.post('/send', async (req, res) => {
        const { jid, message } = req.body;
        try {
            await sock.sendMessage(jid, { text: message });
            res.status(200).json({ status: 'sent', instance: INSTANCE_NAME });
        } catch (e) {
            console.error("Error al enviar mensaje:", e.message);
            res.status(500).json({ error: e.message });
        }
    });
}

// Ruta de salud para verificar en el navegador
app.get('/', (req, res) => res.send(`Puente WhatsApp Activo - Instancia: ${INSTANCE_NAME}`));

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor de ${INSTANCE_NAME} escuchando en el puerto ${PORT}`);
    startWhatsApp().catch(err => console.log("Error al arrancar:", err));
});

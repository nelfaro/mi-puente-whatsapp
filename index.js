const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://neogen-n8n-n8n.8fevsr.easypanel.host/webhook/whatsapp-entrada';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'WhatsApp-Principal';
const SESSION_FOLDER = `./session_${INSTANCE_NAME.replace(/\s+/g, '_')}`;

let qrCodeData = null;
let connectionStatus = "Desconectado";
let sock = null;

async function startWhatsApp() {
    console.log(`\n> Iniciando Instancia: [${INSTANCE_NAME}]`);
    
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            QRCode.toDataURL(qr, (err, url) => { qrCodeData = url; });
            qrcodeTerminal.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            connectionStatus = "Desconectado";
            qrCodeData = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            // Si el usuario cerró sesión, limpiamos y esperamos acción manual o reinicio automático suave
            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`❌ Sesión cerrada en ${INSTANCE_NAME}.`);
                if (fs.existsSync(SESSION_FOLDER)) {
                    fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                }
            }
            
            // Intentar reconectar siempre que no sea un cierre voluntario total
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => startWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            connectionStatus = "Conectado";
            qrCodeData = null;
            console.log(`✅ [${INSTANCE_NAME}] CONECTADO`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.message && N8N_WEBHOOK_URL) {
            const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (texto) {
                try {
                    await axios.post(N8N_WEBHOOK_URL, { 
                        instance: INSTANCE_NAME,
                        sender: msg.key.remoteJid,
                        nombre: msg.pushName || 'Contacto',
                        texto: texto
                    });
                } catch (e) { console.error("Error n8n"); }
            }
        }
    });
}

// INTERFAZ WEB
app.get('/', (req, res) => {
    const btnColor = connectionStatus === 'Conectado' ? '#FF3B30' : '#007AFF';
    const btnText = connectionStatus === 'Conectado' ? 'Desconectar WhatsApp' : 'Generar Nuevo QR';

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Panel ${INSTANCE_NAME}</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; background: #f4f7f6; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .card { background: white; padding: 2rem; border-radius: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); text-align: center; width: 90%; max-width: 400px; }
                .status { font-size: 1.2rem; font-weight: bold; margin-bottom: 1rem; color: ${connectionStatus === 'Conectado' ? '#25D366' : '#FF3B30'}; }
                img { width: 250px; margin: 1rem 0; border: 1px solid #ddd; padding: 10px; border-radius: 10px; }
                .btn { background: ${btnColor}; color: white; border: none; padding: 12px 25px; border-radius: 10px; cursor: pointer; font-size: 1rem; width: 100%; transition: 0.3s; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>${INSTANCE_NAME}</h1>
                <div class="status">● ${connectionStatus}</div>
                ${qrCodeData ? `<div>Escanea el QR:</div><img src="${qrCodeData}">` : connectionStatus === 'Conectado' ? '<div style="font-size: 4rem;">✅</div><p>WhatsApp vinculado.</p>' : '<p>Generando código QR...</p>'}
                <form action="/logout" method="POST">
                    <button class="btn" type="submit">${btnText}</button>
                </form>
                <br>
                <a href="#" onclick="location.reload()" style="font-size: 0.8rem; color: #888;">Actualizar Estado</a>
            </div>
        </body>
        </html>
    `);
});

app.post('/logout', async (req, res) => {
    try {
        console.log(`Acción de limpieza solicitada para ${INSTANCE_NAME}`);
        
        // 1. Intentamos cerrar la conexión limpiamente si existe
        if (sock) {
            sock.end(new Error("Reinicio solicitado"));
        }

        // 2. Borramos la carpeta de sesión
        if (fs.existsSync(SESSION_FOLDER)) {
            fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
        }

        // 3. Esperamos un poco y reiniciamos el proceso de WhatsApp sin apagar el servidor
        setTimeout(() => {
            startWhatsApp();
        }, 2000);

        res.send('<script>alert("Reiniciando instancia..."); window.location.href="/";</script>');
    } catch (e) { 
        res.send('Error al reiniciar.'); 
    }
});

app.post('/send', async (req, res) => {
    const { jid, message } = req.body;
    try {
        if (!sock) throw new Error("WhatsApp no iniciado");
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

startWhatsApp();
app.listen(PORT, "0.0.0.0");

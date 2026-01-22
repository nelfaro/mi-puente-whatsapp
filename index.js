const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://neogen-n8n-n8n.8fevsr.easypanel.host/webhook/whatsapp-entrada';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'WhatsApp-Principal';
const SESSION_FOLDER = './auth_info'; 

let qrCodeData = null;
let connectionStatus = "Iniciando...";
let userNumber = null;
let sock = null;
let isStarting = false;

// 1. ARRANCAR EL SERVIDOR WEB DE INMEDIATO PARA EVITAR SIGTERM
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Servidor Web de ${INSTANCE_NAME} listo en puerto ${PORT}`);
    startWhatsApp();
});

async function startWhatsApp() {
    if (isStarting) return;
    isStarting = true;

    try {
        console.log(`> Conectando instancia de WhatsApp...`);
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
        
        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' })
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                connectionStatus = "Esperando Escaneo";
                qrCodeData = await QRCode.toDataURL(qr);
            }
            
            if (connection === 'close') {
                isStarting = false;
                qrCodeData = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log("❌ Sesión cerrada permanentemente.");
                    connectionStatus = "Sesión Cerrada";
                    if (fs.existsSync(SESSION_FOLDER)) fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                } else {
                    console.log("Reconectando...");
                    connectionStatus = "Reconectando...";
                }
                setTimeout(() => startWhatsApp(), 5000);
            } else if (connection === 'open') {
                isStarting = false;
                connectionStatus = "Conectado";
                qrCodeData = null;
                userNumber = sock.user.id.split(':')[0];
                console.log(`✅ CONECTADO EXITOSAMENTE: ${userNumber}`);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.key.fromMe && msg.message) {
                const m = msg.message;
                const texto = m.conversation || m.extendedTextMessage?.text;
                
                // Detección de archivos multimedia
                const isAudio = !!m.audioMessage;
                const isImage = !!m.imageMessage;
                const isDocument = !!m.documentMessage;

                const formData = new FormData();
                formData.append('instance', INSTANCE_NAME);
                formData.append('sender', msg.key.remoteJid);
                formData.append('nombre', msg.pushName || 'Contacto');

                if (isAudio || isImage || isDocument) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        
                        // Lógica de nombres y extensiones para que OpenAI no de error
                        let filename = 'archivo';
                        let mimetype = 'application/octet-stream';

                        if (isAudio) { 
                            filename = 'audio.ogg'; 
                            mimetype = 'audio/ogg'; 
                        } else if (isImage) { 
                            filename = 'imagen.jpg'; 
                            mimetype = 'image/jpeg'; 
                        } else if (isDocument) { 
                            filename = m.documentMessage.fileName || 'documento.pdf'; 
                            mimetype = m.documentMessage.mimetype || 'application/pdf'; 
                        }

                        formData.append('file', buffer, { filename, contentType: mimetype });
                        formData.append('texto', '[[ARCHIVO_MULTIMEDIA]]');
                    } catch (e) { 
                        console.error("Error descargando media:", e.message); 
                    }
                } else if (texto) {
                    formData.append('texto', texto);
                } else {
                    return; 
                }

                axios.post(N8N_WEBHOOK_URL, formData, { headers: formData.getHeaders() })
                     .catch(e => console.error("Error enviando a n8n:", e.message));
            }
        });

    } catch (e) {
        isStarting = false;
        console.error("Error crítico en startWhatsApp:", e);
    }
}

// ENDPOINTS PARA LA UI Y N8N
app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeData, number: userNumber }));

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html><html><head><title>Panel WhatsApp</title><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font-family:sans-serif;background:#f4f7f6;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:white;padding:2rem;border-radius:20px;box-shadow:0 10px 25px rgba(0,0,0,0.1);text-align:center;width:90%;max-width:400px}.status-dot{width:12px;height:12px;border-radius:50%;display:inline-block;margin-right:8px}.btn{color:white;border:none;padding:12px 25px;border-radius:10px;cursor:pointer;width:100%;margin-top:15px;text-decoration:none;display:block}.btn-red{background:#FF3B30}.btn-blue{background:#007AFF}.hidden{display:none}</style></head>
        <body><div class="card"><h1>${INSTANCE_NAME}</h1><div id="status-container" style="font-weight:bold;margin-bottom:20px">Cargando...</div><div id="qr-container" class="hidden"><img id="qr-img" src="" style="width:250px;border:1px solid #ddd;border-radius:10px"></div><div id="connected-container" class="hidden"><p style="font-size:3rem">✅</p><div id="phone-number" style="font-size:1.2rem;font-weight:bold"></div></div><form action="/logout" method="POST" onsubmit="return confirm('¿Desconectar?')"><button id="action-btn" class="btn btn-blue" type="submit">Reiniciar</button></form></div>
        <script>async function updateStatus(){try{const e=await fetch("/status"),t=await e.json(),n=document.getElementById("status-container"),a=document.getElementById("qr-container"),d=document.getElementById("connected-container"),s=document.getElementById("action-btn");n.innerHTML='<span class="status-dot" style="background:'+("Conectado"===t.status?"#25D366":"#FF3B30")+'"></span>'+t.status,"Conectado"===t.status?(d.classList.remove("hidden"),a.classList.add("hidden"),document.getElementById("phone-number").innerText="+"+t.number,s.innerText="Desconectar",s.className="btn btn-red"):t.qr&&(a.classList.remove("hidden"),d.classList.add("hidden"),document.getElementById("qr-img").src=t.qr,s.innerText="Nuevo QR",s.className="btn btn-blue")}catch(e){}}setInterval(updateStatus,2000),updateStatus();</script></body></html>
    `);
});

app.post('/logout', async (req, res) => {
    if (fs.existsSync(SESSION_FOLDER)) fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
    res.send('<script>window.location.href="/";</script>');
    process.exit(0); 
});

app.post('/send', async (req, res) => {
    const { jid, message } = req.body;
    try {
        if (!sock) return res.status(500).json({ error: "WhatsApp no conectado" });
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

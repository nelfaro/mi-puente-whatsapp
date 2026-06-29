const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadMediaMessage, 
    fetchLatestBaileysVersion, 
    Browsers 
} = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');
const multer = require('multer'); // <-- NUEVA LIBRERÍA PARA RECIBIR ARCHIVOS

const app = express();
app.use(express.json({ limit: '50mb' })); // <-- Aumenta el límite para recibir imágenes pesadas
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Configuración para recibir archivos temporales de n8n
const upload = multer({ dest: '/tmp/' });

// --- CONFIGURACIÓN ---
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'WhatsApp-Principal';
const SESSION_FOLDER = process.env.SESSION_FOLDER || '/app/auth_info';

let qrCodeData = null;
let connectionStatus = "Desconectado";
let userNumber = null;
let sock = null;

function clearSessionFiles() {
    if (fs.existsSync(SESSION_FOLDER)) {
        console.log("🧹 Limpiando archivos de sesión antiguos...");
        const files = fs.readdirSync(SESSION_FOLDER);
        for (const file of files) {
            try {
                fs.rmSync(path.join(SESSION_FOLDER, file), { recursive: true, force: true });
            } catch (e) {}
        }
    }
}

async function startWhatsApp() {
    console.log(`\n🚀 Iniciando instancia: ${INSTANCE_NAME}`);
    
    try {
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`> Conectando con versión v${version.join('.')} (Latest: ${isLatest})`);

        if (!fs.existsSync(SESSION_FOLDER)) fs.mkdirSync(SESSION_FOLDER, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }), // <-- Puesto en 'silent' para ocultar los logs raros de encriptación
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionStatus = "Esperando Escaneo";
                qrCodeData = await QRCode.toDataURL(qr);
            }

            if (connection === 'close') {
                qrCodeData = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const sessionErrors = [DisconnectReason.loggedOut, 401, 403, 405, 440];

                if (sessionErrors.includes(statusCode)) {
                    connectionStatus = "Sesión Expirada";
                    clearSessionFiles();
                }
                setTimeout(() => startWhatsApp(), 5000);
            } else if (connection === 'open') {
                console.log(`✅ ¡CONECTADO EXITOSAMENTE!`);
                connectionStatus = "Conectado";
                qrCodeData = null;
                userNumber = sock.user.id.split(':')[0];
            }
        });

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
                        let filename = m.audioMessage ? 'audio.ogg' : m.imageMessage ? 'imagen.jpg' : 'archivo';
                        let mimetype = m.audioMessage ? 'audio/ogg' : m.imageMessage ? 'image/jpeg' : 'application/octet-stream';
                        formData.append('file', buffer, { filename, contentType: mimetype });
                        formData.append('texto', '[[ARCHIVO_MULTIMEDIA]]');
                    } catch (e) {}
                } else if (texto) {
                    formData.append('texto', texto);
                } else { return; }

                axios.post(N8N_WEBHOOK_URL, formData, { headers: formData.getHeaders() }).catch(e => {});
            }
        });
    } catch (error) {
        setTimeout(() => startWhatsApp(), 10000);
    }
}

// --- SERVIDOR EXPRESS ---
app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeData, number: userNumber }));

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Panel WhatsApp</title><style>body{font-family:sans-serif;background:#f4f7f6;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:white;padding:2rem;border-radius:20px;box-shadow:0 10px 25px rgba(0,0,0,0.1);text-align:center;width:90%;max-width:400px}.btn{color:white;border:none;padding:12px 25px;border-radius:10px;cursor:pointer;width:100%;margin-top:15px}.btn-red{background:#FF3B30}.btn-blue{background:#007AFF}.hidden{display:none}</style></head><body><div class="card"><h1>${INSTANCE_NAME}</h1><div id="status-container" style="font-weight:bold;margin-bottom:20px">Cargando...</div><div id="qr-container" class="hidden"><img id="qr-img" src="" style="width:250px;"></div><div id="connected-container" class="hidden"><p style="font-size:3rem">✅</p><div id="phone-number"></div></div><form action="/logout" method="POST"><button id="action-btn" class="btn btn-blue" type="submit">Reiniciar</button></form></div><script>async function updateStatus(){try{const e=await fetch("/status"),t=await e.json(),n=document.getElementById("status-container"),a=document.getElementById("qr-container"),d=document.getElementById("connected-container"),s=document.getElementById("action-btn");n.innerHTML=t.status,"Conectado"===t.status?(d.classList.remove("hidden"),a.classList.add("hidden"),document.getElementById("phone-number").innerText="+"+t.number,s.innerText="Desconectar",s.className="btn btn-red"):t.qr?(a.classList.remove("hidden"),d.classList.add("hidden"),document.getElementById("qr-img").src=t.qr,s.innerText="Generar Nuevo QR",s.className="btn btn-blue"):(a.classList.add("hidden"),d.classList.add("hidden"),s.innerText="Sincronizando...",s.className="btn btn-blue")}catch(e){}}setInterval(updateStatus,2000),updateStatus();</script></body></html>`);
});

app.post('/logout', (req, res) => {
    clearSessionFiles();
    res.send('<script>window.location.href="/";</script>');
    if (sock) sock.end();
    setTimeout(() => startWhatsApp(), 2000);
});

// --- EL NUEVO ENDPOINT UNIVERSAL (Acepta Texto, imagen en base64 (texto) y Archivos desde n8n) ---
app.post('/send', upload.single('file'), async (req, res) => {
    try {
        // Extraemos los datos del body
        const { jid, type, message, caption, filename, image } = req.body;

        if (!sock) return res.status(500).json({ error: "Servicio no listo" });

        // --- LÓGICA DE ENVÍO DE IMAGEN ---
        if (type === 'image' || image) {
            let mediaContent;

            if (typeof image === 'string' && image.startsWith('data:image')) {
                // 1. Extraer solo el contenido base64 (quitando el prefijo data:image/xxx;base64,)
                const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
                // 2. Convertir a Buffer (Binario)
                mediaContent = Buffer.from(base64Data, 'base64');
            } 
            else if (typeof image === 'string' && image.startsWith('http')) {
                // Es una URL externa
                mediaContent = { url: image };
            } 
            else if (req.file) {
                // Es un archivo subido por Multer (físico)
                mediaContent = fs.readFileSync(req.file.path);
            }

            if (!mediaContent) throw new Error("No se pudo determinar el contenido de la imagen");

            // Enviamos a WhatsApp
            await sock.sendMessage(jid, { 
                image: mediaContent, 
                caption: caption || message || '' 
            });

            // Si se creó un archivo temporal, lo borramos
            if (req.file) fs.unlinkSync(req.file.path);
            
            return res.json({ status: 'sent', type: 'image' });
        } 
        
        // --- LÓGICA DE ENVÍO DE DOCUMENTO ---
        else if (type === 'document' && req.file) {
            await sock.sendMessage(jid, {
                document: fs.readFileSync(req.file.path),
                mimetype: 'application/pdf',
                fileName: filename || 'Documento.pdf',
                caption: caption || ''
            });
            fs.unlinkSync(req.file.path);
            return res.json({ status: 'sent', type: 'document' });
        } 
        
        // --- LÓGICA DE TEXTO SIMPLE ---
        else {
            await sock.sendMessage(jid, { text: message });
            return res.json({ status: 'sent', type: 'text' });
        }
        
    } catch (e) { 
        console.error("Error detallado enviando mensaje:", e);
        res.status(500).json({ error: e.message }); 
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Servidor Web listo en puerto ${PORT}`);
    startWhatsApp();
});

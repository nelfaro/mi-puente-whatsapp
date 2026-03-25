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

const app = express();
app.use(express.json());

// --- CONFIGURACIÓN ---
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://agentes-n8n.xjkmv6.easypanel.host/webhook/whatsapp-entrada';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'WhatsApp-Principal';
const SESSION_FOLDER = '/app/auth_info'; 

let qrCodeData = null;
let connectionStatus = "Desconectado";
let userNumber = null;
let sock = null;

// Función para vaciar la carpeta de sesión de forma segura
function clearSessionFiles() {
    if (fs.existsSync(SESSION_FOLDER)) {
        console.log("🧹 Limpiando archivos de sesión antiguos para resolver conflictos...");
        const files = fs.readdirSync(SESSION_FOLDER);
        for (const file of files) {
            try {
                const filePath = path.join(SESSION_FOLDER, file);
                fs.rmSync(filePath, { recursive: true, force: true });
            } catch (e) {
                console.log(`⚠️ No se pudo borrar ${file}: ${e.message}`);
            }
        }
    }
}

async function startWhatsApp() {
    console.log(`\n🚀 Iniciando instancia: ${INSTANCE_NAME}`);
    
    try {
        // 1. OBTENER LA ÚLTIMA VERSIÓN DE WHATSAPP WEB (Solución al error 405)
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`> Conectando con versión de WhatsApp Web v${version.join('.')} (Latest: ${isLatest})`);

        // 2. PREPARAR ESTADO DE AUTENTICACIÓN
        if (!fs.existsSync(SESSION_FOLDER)) {
            fs.mkdirSync(SESSION_FOLDER, { recursive: true });
        }
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

        // 3. CONFIGURAR EL SOCKET
        sock = makeWASocket({
            version, // Muy importante para evitar el 405
            auth: state,
            logger: pino({ level: 'error' }),
            printQRInTerminal: false,
            // Identidad del navegador: Ubuntu con Chrome es la más estable para Baileys
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            generateHighQualityLinkPreview: true,
        });

        // Guardar credenciales automáticamente
        sock.ev.on('creds.update', saveCreds);

        // Gestión de la conexión
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionStatus = "Esperando Escaneo";
                qrCodeData = await QRCode.toDataURL(qr);
                console.log("✨ Nuevo código QR generado.");
            }

            if (connection === 'close') {
                qrCodeData = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`⚠️ Conexión cerrada. Código de estado: ${statusCode}`);

                // Errores que indican que la sesión debe ser reseteada
                const sessionErrors = [DisconnectReason.loggedOut, 401, 403, 405, 440];

                if (sessionErrors.includes(statusCode)) {
                    console.log("💥 Error crítico detectado. Reiniciando sesión completa...");
                    connectionStatus = "Sesión Expirada";
                    clearSessionFiles();
                    setTimeout(() => startWhatsApp(), 5000);
                } else {
                    console.log("Reintentando conexión automática en 5 segundos...");
                    setTimeout(() => startWhatsApp(), 5000);
                }
            } else if (connection === 'open') {
                console.log(`✅ ¡CONECTADO EXITOSAMENTE!`);
                connectionStatus = "Conectado";
                qrCodeData = null;
                userNumber = sock.user.id.split(':')[0];
            }
        });

        // Lógica de recepción de mensajes (Multimedia + Texto)
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
                        let filename = m.audioMessage ? 'audio.ogg' : m.imageMessage ? 'imagen.jpg' : (m.documentMessage.fileName || 'archivo');
                        let mimetype = m.audioMessage ? 'audio/ogg' : m.imageMessage ? 'image/jpeg' : (m.documentMessage.mimetype || 'application/octet-stream');
                        
                        formData.append('file', buffer, { filename, contentType: mimetype });
                        formData.append('texto', '[[ARCHIVO_MULTIMEDIA]]');
                    } catch (e) { console.error("Error descargando media:", e.message); }
                } else if (texto) {
                    formData.append('texto', texto);
                } else { return; }

                axios.post(N8N_WEBHOOK_URL, formData, { headers: formData.getHeaders() }).catch(e => {});
            }
        });

    } catch (error) {
        console.error("❌ Fallo al iniciar WhatsApp:", error);
        setTimeout(() => startWhatsApp(), 10000);
    }
}

// --- SERVIDOR EXPRESS (UI Y API) ---
app.get('/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeData, number: userNumber }));

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html><html><head><title>Panel WhatsApp</title><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font-family:sans-serif;background:#f4f7f6;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:white;padding:2rem;border-radius:20px;box-shadow:0 10px 25px rgba(0,0,0,0.1);text-align:center;width:90%;max-width:400px}.status-dot{width:12px;height:12px;border-radius:50%;display:inline-block;margin-right:8px}.btn{color:white;border:none;padding:12px 25px;border-radius:10px;cursor:pointer;width:100%;margin-top:15px;text-decoration:none;display:block}.btn-red{background:#FF3B30}.btn-blue{background:#007AFF}.hidden{display:none}</style>
        </head><body><div class="card"><h1>${INSTANCE_NAME}</h1><div id="status-container" style="font-weight:bold;margin-bottom:20px">Cargando...</div><div id="qr-container" class="hidden"><p>Escanea el QR:</p><img id="qr-img" src="" style="width:250px;border:1px solid #ddd;border-radius:10px"></div><div id="connected-container" class="hidden"><p style="font-size:3rem">✅</p><div id="phone-number" style="font-size:1.2rem;font-weight:bold"></div></div>
        <form action="/logout" method="POST" onsubmit="return confirm('¿Desconectar?')"><button id="action-btn" class="btn btn-blue" type="submit">Reiniciar</button></form></div>
        <script>async function updateStatus(){try{const e=await fetch("/status"),t=await e.json(),n=document.getElementById("status-container"),a=document.getElementById("qr-container"),d=document.getElementById("connected-container"),s=document.getElementById("action-btn");n.innerHTML='<span class="status-dot" style="background:'+("Conectado"===t.status?"#25D366":"#FF3B30")+'"></span>'+t.status,"Conectado"===t.status?(d.classList.remove("hidden"),a.classList.add("hidden"),document.getElementById("phone-number").innerText="+"+t.number,s.innerText="Desconectar",s.className="btn btn-red"):t.qr?(a.classList.remove("hidden"),d.classList.add("hidden"),document.getElementById("qr-img").src=t.qr,s.innerText="Generar Nuevo QR",s.className="btn btn-blue"):(a.classList.add("hidden"),d.classList.add("hidden"),s.innerText="Sincronizando...",s.className="btn btn-blue")}catch(e){}}setInterval(updateStatus,2000),updateStatus();</script></body></html>
    `);
});

app.post('/logout', (req, res) => {
    console.log("Cierre de sesión manual solicitado...");
    clearSessionFiles();
    res.send('<script>window.location.href="/";</script>');
    if (sock) {
        sock.end();
        sock = null;
    }
    setTimeout(() => startWhatsApp(), 2000);
});

app.post('/send', async (req, res) => {
    const { jid, message } = req.body;
    try {
        if (!sock) return res.status(500).json({ error: "Servicio no listo" });
        await sock.sendMessage(jid, { text: message });
        res.json({ status: 'sent' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Servidor Web listo en puerto ${PORT}`);
    startWhatsApp();
});

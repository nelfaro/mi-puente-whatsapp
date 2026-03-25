const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");

const P = require("pino");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const { Boom } = require("@hapi/boom");

const SESSION_DIR = "./auth_info_baileys";
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

// 🚫 NUNCA BORRAR SESIÓN AUTOMÁTICAMENTE
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

async function startSock() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: P({ level: "silent" }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" }))
      },
      printQRInTerminal: true,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    sock.ev.on("creds.update", saveCreds);

    // 🔄 Manejo de conexión
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "close") {
        const shouldReconnect =
          (lastDisconnect?.error instanceof Boom &&
            lastDisconnect.error.output?.statusCode !==
              DisconnectReason.loggedOut);

        console.log("🔌 Conexión cerrada.");

        if (shouldReconnect) {
          console.log("♻️ Reconectando...");
          startSock();
        } else {
          console.log("🚪 Sesión cerrada. Requiere nuevo QR.");
        }
      }

      if (connection === "open") {
        console.log("✅ ¡CONECTADO EXITOSAMENTE!");
      }
    });

    // 📩 Mensajes entrantes
    sock.ev.on("messages.upsert", async (m) => {
      try {
        const msg = m.messages[0];

        if (!msg.message) return;
        if (msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const messageId = msg.key.id;
        const fromMe = msg.key.fromMe;
        const messageTimestamp = msg.messageTimestamp
          ? msg.messageTimestamp * 1000
          : Date.now();

        const texto =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        const nombre = msg.pushName || "Sin nombre";

        console.log("📩 Mensaje recibido:", texto);

        // 🚀 Enviar a n8n
        const formData = new FormData();
        formData.append("instance", "WhatsApp-Principal");
        formData.append("sender", sender);
        formData.append("nombre", nombre);
        formData.append("texto", texto);

        // 🆕 NUEVOS CAMPOS
        formData.append("messageTimestamp", messageTimestamp);
        formData.append("messageId", messageId);
        formData.append("fromMe", fromMe);

        await axios.post(N8N_WEBHOOK_URL, formData, {
          headers: formData.getHeaders(),
          timeout: 10000
        });

      } catch (err) {
        // 🔐 Ignorar errores de sesión
        if (err?.name === "SessionError") {
          console.log("⚠️ Session perdida. Ignorando mensaje corrupto.");
          return;
        }

        console.error("❌ Error procesando mensaje:", err.message);
      }
    });

  } catch (error) {
    console.error("💥 Error crítico inicializando socket:", error.message);
    setTimeout(() => startSock(), 5000);
  }
}

startSock();

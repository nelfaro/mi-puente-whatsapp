const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

// ... (resto de variables igual)

async function startWhatsApp() {
    console.log(`\n🚀 Sincronizando versión con WhatsApp...`);
    
    try {
        // FORZAMOS LA ÚLTIMA VERSIÓN PARA EVITAR EL ERROR 405
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`> Usando versión de WA: ${version.join('.')} (Es la última: ${isLatest})`);

        const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

        sock = makeWASocket({
            version, // <--- ESTO ES LO QUE ARREGLA EL 405
            auth: state,
            logger: pino({ level: 'error' }),
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '110.0.5481.177'], // Navegador moderno
            connectTimeoutMs: 60000,
        });

        // ... (resto del código de eventos igual)

    } catch (err) {
        console.error("Error al sincronizar versión:", err);
        setTimeout(() => startWhatsApp(), 10000);
    }
}

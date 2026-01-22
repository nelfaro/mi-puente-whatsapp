// ... (resto del código arriba igual)

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.key.fromMe && msg.message) {
                const m = msg.message;
                const texto = m.conversation || m.extendedTextMessage?.text;
                
                // Detectamos qué tipo de archivo es
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
                        
                        // DETERMINAMOS LA EXTENSIÓN (Esto es lo que OpenAI necesita)
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
                    } catch (e) { console.error("Error al descargar multimedia:", e.message); }
                } else if (texto) {
                    formData.append('texto', texto);
                } else { return; }

                axios.post(N8N_WEBHOOK_URL, formData, { headers: formData.getHeaders() })
                     .catch(e => console.error("Error n8n:", e.message));
            }
        });

// ... (resto del código abajo igual)

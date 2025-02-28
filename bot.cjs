const baileys = require('@whiskeysockets/baileys');
const axios = require('axios');
const qrcode = require('qrcode-terminal');

async function startBot() {
    const { state, saveCreds } = await baileys.useMultiFileAuthState('auth_info');
    const sock = baileys.default({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection }) => {
        if (connection === 'close') {
            console.log('Conexão fechada. Tentando reconectar...');
            startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot conectado!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        
        // Ignorar mensagens do próprio bot ou sem conteúdo relevante
        if (!msg.message || msg.key.fromMe) return;

        // Extrai o texto da mensagem, considerando diferentes formatos
        const userMessage = (msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || 
                             msg.message.videoMessage?.caption || 
                             msg.message.documentMessage?.caption || 
                             "").trim();

        // Filtra apenas mensagens que começam com '!'
        if (!userMessage.startsWith("!")) return;

        console.log("📩 Mensagem filtrada:", userMessage);

        // Verifica se o código tem exatamente 8 caracteres
        if (userMessage.length !== 9) { // 1 do "!" + 8 do código = 9 caracteres no total
            await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ O código precisa ter exatamente 8 caracteres!" });
            return;
        }

        const codigoProduto = userMessage.slice(1); // Remove o "!"
        console.log("🔎 Código extraído:", codigoProduto);

        try {
            const response = await axios.get(`https://utepecem.com/sigma/api/getProduto/${codigoProduto}/todas/xEQ2y0SZufH5L1wJ2K98MVqCtjU8Sq6Z`);

            if (response.data.success && response.data.data) {
                const produto = response.data.data;
                const estoqueInfo = produto.estoques.map(e =>
                    `🏢 ${e.empresa} - Local ${e.localizacao}: ${e.qAtual} disponíveis`
                ).join("\n");

                const mensagemResposta = `📦 *Produto Encontrado!*\n\n` +
                    `🔹 *Código*: ${produto.id}\n` +
                    `🔹 *Nome*: ${produto.texto_breve}\n` +
                    `🔹 *Descrição*: ${produto.texto_completo}\n` +
                    `🔹 *Unidade*: ${produto.unidade}\n\n` +
                    `📍 *Estoque por Localização:*\n${estoqueInfo}`;

                await sock.sendMessage(msg.key.remoteJid, { text: mensagemResposta });
            } else {
                await sock.sendMessage(msg.key.remoteJid, { text: "❌ Produto não encontrado ou está bloqueado!" });
            }
        } catch (error) {
            console.error("Erro ao buscar o produto:", error);
            await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ Erro ao consultar o produto!" });
        }
    });
}

// Inicia o bot
startBot();

const baileys = require('@whiskeysockets/baileys');
const axios = require('axios');

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
        
        if (!msg.message || msg.key.fromMe) return;

        const userMessage = (msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || 
                             msg.message.videoMessage?.caption || 
                             msg.message.documentMessage?.caption || 
                             "").trim();

        if (!userMessage.startsWith("!")) return;

        console.log("📩 Mensagem filtrada:", userMessage);

        if (userMessage.length !== 9) {
            await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ O código precisa ter exatamente 8 caracteres!" });
            return;
        }

        const codigoProduto = userMessage.slice(1);
        console.log("🔎 Código extraído:", codigoProduto);

        try {
            const response = await axios.get(`https://utepecem.com/sigma/api/getProduto/${codigoProduto}/todas/xEQ2y0SZufH5L1wJ2K98MVqCtjU8Sq6Z`);

            if (response.data.success && response.data.data) {
                const produto = response.data.data;
            
                
                const estoqueInfo = produto.estoques.map(e => {
                    const unidade1 = produto.unidade
                    const nomeEmpresa = e.empresa === "PTPC" ? "PPTM" : e.empresa === "GTPC" ? "EP" : e.empresa;
                    const estoqueMsg = e.qAtual > 0 

                        ? `${e.qAtual}` + " " + unidade1
                        : `❌`;

                    return `🏭 ${nomeEmpresa} - ${e.localizacao}: _${estoqueMsg}_`;
                }).join("\n");

                // Obtém os valores do estoque de segurança e substitui os nomes das empresas
                const estoqueSegurancaPTPC = produto.estoque_seguranca_pptm ?? 0;
                const estoqueSegurancaGTPC = produto.estoque_seguranca ?? 0;
                const unidade = produto.unidade

                const estoqueSegurancaInfo = `🏭 _*PPTM:*_ ${estoqueSegurancaPTPC > 0 ? estoqueSegurancaPTPC + " " + unidade : "❌"}\n` +
                                             `🏭 _*EP:*_ ${estoqueSegurancaGTPC > 0 ? estoqueSegurancaGTPC + " " + unidade : "❌"}`;

                // Monta a mensagem final
                const mensagemResposta = `         📦 _*Produto Encontrado!*_\n\n` +
                    `📌  _*Código:*_ ${produto.id}\n` +
                    `📃  _*Texto breve:*_ ${produto.texto_breve}\n` +
                    `📝  _*Descrição completa:*_ ${produto.texto_completo}\n\n` +
                    `📍  _*Estoque por Localização:*_ \n${estoqueInfo}\n\n` +
                    `⚠️  _*Estoque de Segurança:*_ \n${estoqueSegurancaInfo}`;

                await sock.sendMessage(msg.key.remoteJid, { text: mensagemResposta });
            } else {
                await sock.sendMessage(msg.key.remoteJid, { text: "❌ _Produto não encontrado ou está bloqueado!_" });
            }
        } catch (error) {
            console.error("Erro ao buscar o produto:", error);
            await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ _Erro ao consultar o produto!_" });
        }
    });
}

startBot();

const baileys = require('@whiskeysockets/baileys');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const path = require('path');

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
                const unidade = produto.unidade;

                // Lê o estoque de segurança das planilhas
                const estoqueSegurancaPPTM = buscarEstoqueSeguranca(codigoProduto, 'PPTM') ?? 0;
                const estoqueSegurancaEP = buscarEstoqueSeguranca(codigoProduto, 'EP') ?? 0;

                const estoqueInfo = produto.estoques.map(e => {
                    const nomeEmpresa = e.empresa === "PTPC" ? "PPTM" : e.empresa === "GTPC" ? "EP" : e.empresa;
                    const estoqueMsg = e.qAtual > 0 
                        ? `${e.qAtual} ${unidade}`
                        : `❌`;

                    return `🏭 ${nomeEmpresa} - ${e.localizacao}: _${estoqueMsg}_`;
                }).join("\n");

                const estoqueSegurancaInfo = `🏭 _*PPTM:*_ ${estoqueSegurancaPPTM > 0 ? estoqueSegurancaPPTM + " " + unidade : "❌"}\n` +
                                             `🏭 _*EP:*_ ${estoqueSegurancaEP > 0 ? estoqueSegurancaEP + " " + unidade : "❌"}`;

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

// Função para buscar estoque de segurança nas planilhas por empresa
function buscarEstoqueSeguranca(codigoProduto, empresa) {
    let arquivo;

    if (empresa === 'PPTM') {
        arquivo = path.join(__dirname, 'Estoque Segurança PPTM.xlsx');
    } else if (empresa === 'EP') {
        arquivo = path.join(__dirname, 'Estoque de segurança - Energia Pecém.xlsx');
    } else {
        return null;
    }

    try {
        const workbook = XLSX.readFile(arquivo);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const dados = XLSX.utils.sheet_to_json(sheet);

        const produtoEncontrado = dados.find(p => 
            String(p.Código).trim() === String(codigoProduto).trim()
        );

        return produtoEncontrado ? produtoEncontrado.EstoqueSeguranca : null;
    } catch (err) {
        console.error(`Erro ao ler a planilha da empresa ${empresa}:`, err);
        return null;
    }
}

startBot();

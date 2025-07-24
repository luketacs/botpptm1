const baileys = require('@whiskeysockets/baileys');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

async function obterEstoqueSeguranca(codigoProduto, empresa) {
    let filePath;
    let colunaEstoque;

    if (empresa === "PTPC") {
        filePath = path.join(__dirname, "Estoque Segurança PPTM.xlsx");
        colunaEstoque = "EstSeg-PPTM";
    } else if (empresa === "GTPC") {
        filePath = path.join(__dirname, "Estoque de segurança - Energia Pecém.xlsx");
        colunaEstoque = "EstSeg-GTPC";
    } else {
        return 0;
    }

    try {
        const workbook = XLSX.readFile(filePath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);

        const row = data.find(r =>
            String(r["Codigo"]).trim().toLowerCase() === String(codigoProduto).trim().toLowerCase()
        );

        return row?.[colunaEstoque] ?? 0;
    } catch (err) {
        console.error("Erro ao ler planilha de estoque de segurança:", err);
        return 0;
    }
}

async function startBot() {
    const { state, saveCreds } = await baileys.useMultiFileAuthState('auth_info1');
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

        if (!msg.message) return;

        const userMessage = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            msg.message.documentMessage?.caption ||
            ""
        ).trim();

        if (!userMessage.startsWith("!")) return;

        console.log("📩 Mensagem filtrada:", userMessage);

        if (userMessage.length !== 9) {
            await sock.sendMessage(msg.key.remoteJid, {
                text: "⚠️ O código precisa ter exatamente 8 caracteres!"
            });
            return;
        }

        const codigoProduto = userMessage.slice(1);
        console.log("🔎 Código extraído:", codigoProduto);

        try {
            const response = await axios.get(`https://utepecem.com/sigma/api/getProduto/${codigoProduto}/todas/xEQ2y0SZufH5L1wJ2K98MVqCtjU8Sq6Z`);

            if (response.status === 200 && response.data.data && response.data.sucess) {
                const produto = response.data.data;
                const unidade = produto.unidade;

                const empresas = ["PTPC", "GTPC"];
                const empresaLabel = { PTPC: "PPTM", GTPC: "EP" };
                const estoquesPorEmpresa = { PTPC: 0, GTPC: 0 };

                produto.estoques.forEach(e => {
                    const quantidade = parseFloat(e.qAtual) || 0;
                    if (e.empresa === "PTPC") {
                        estoquesPorEmpresa.PTPC += quantidade;
                    } else if (e.empresa === "GTPC") {
                        estoquesPorEmpresa.GTPC += quantidade;
                    }
                });

                const estoqueInfo = empresas.map(emp => {
                    const nome = empresaLabel[emp];
                    const qtd = estoquesPorEmpresa[emp];
                    return `🏭 _*${nome}:*_ ${qtd > 0 ? `${qtd} ${unidade}` : "❌"}`;
                }).join("\n");

                const estoqueSegurancaPTPC = await obterEstoqueSeguranca(produto.id, "PTPC");
                const estoqueSegurancaGTPC = await obterEstoqueSeguranca(produto.id, "GTPC");

                const estoqueSegurancaInfo =
                    `🏭 _*PPTM:*_ ${estoqueSegurancaPTPC > 0 ? estoqueSegurancaPTPC + " " + unidade : "❌"}\n` +
                    `🏭 _*EP:*_ ${estoqueSegurancaGTPC > 0 ? estoqueSegurancaGTPC + " " + unidade : "❌"}`;

                const mensagemResposta = `         📦 _*Produto Encontrado!*_\n\n` +
                    `📌  _*Código:*_ ${produto.id}\n` +
                    `📃  _*Texto breve:*_ ${produto.texto_breve}\n` +
                    `📝  _*Descrição completa:*_ ${produto.texto_completo}\n\n` +
                    `📍  _*Estoque por Empresa:*_\n${estoqueInfo}\n\n` +
                    `⚠️  _*Estoque de Segurança:*_\n${estoqueSegurancaInfo}`;

                await sock.sendMessage(msg.key.remoteJid, { text: mensagemResposta });
            } else {
                const erroApi = response.data?.message || "Comunicação com o Protheus está temporariamente offline.";
                await sock.sendMessage(msg.key.remoteJid, {
                    text: `❌ _Produto não encontrado!_\n🛠️ Detalhes: ${erroApi}`
                });
            }
        } catch (error) {
            console.error("Erro ao buscar o produto:", error);
            await sock.sendMessage(msg.key.remoteJid, {
                text: "⚠️ Erro ao consultar o produto! Comunicação com o Protheus está temporariamente offline."
            });
        }
    });
}

// ✅ Chamada correta da função (fora da definição dela)
startBot();

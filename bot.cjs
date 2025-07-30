global.crypto = require('crypto');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Boom
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const https = require('https');
const { Agent } = require('http');

// Função para buscar estoque de segurança
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
    console.error("❌ Erro ao ler planilha:", err);
    return 0;
  }
}

// Função principal do bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'info' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📲 Escaneie o QR Code abaixo com o WhatsApp para conectar:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ Bot conectado com sucesso!');
    }

    if (connection === 'close') {
      const reasonCode = lastDisconnect?.error?.output?.statusCode;

      if (reasonCode !== DisconnectReason.loggedOut) {
        console.log('🔄 Tentando reconectar...');
        await startBot();
      } else {
        console.log('🛑 Sessão expirada. Apague a pasta "auth_info" para fazer login novamente.');
      }
    }
  });

  // Comando principal
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const text = msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      msg.message.documentMessage?.caption || "";

    const userMessage = text.trim();

    if (!userMessage.startsWith('!')) return;

    if (userMessage.length !== 9) {
      await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ O código precisa ter exatamente 8 caracteres após o '!'" });
      return;
    }

    const codigoProduto = userMessage.slice(1);

    try {
      const https = require('https');
      const agent = new https.Agent({rejectUnauthorized: false,})
      const response = await axios.get(`https://utepecem.com/sigma/api/getProduto/${codigoProduto}/todas/xEQ2y0SZufH5L1wJ2K98MVqCtjU8Sq6Z`, { httpsAgent: agent});

      if (response.status === 200 && response.data.success && response.data.data) {
        const produto = response.data.data;
        const unidade = produto.unidade;

        const estoques = { PTPC: 0, GTPC: 0 };
        produto.estoques.forEach(e => {
          const qtd = parseFloat(e.qAtual) || 0;
          if (e.empresa === "PTPC") estoques.PTPC += qtd;
          if (e.empresa === "GTPC") estoques.GTPC += qtd;
        });

        const estoqueInfo = [
          `🏭 _*PPTM:*_ ${estoques.PTPC > 0 ? `${estoques.PTPC} ${unidade}` : "❌"}`,
          `🏭 _*EP:*_ ${estoques.GTPC > 0 ? `${estoques.GTPC} ${unidade}` : "❌"}`
        ].join('\n');

        const estoqueSegPTPC = await obterEstoqueSeguranca(produto.id, "PTPC");
        const estoqueSegGTPC = await obterEstoqueSeguranca(produto.id, "GTPC");

        const estoqueSegInfo = [
          `🏭 _*PPTM:*_ ${estoqueSegPTPC > 0 ? `${estoqueSegPTPC} ${unidade}` : "❌"}`,
          `🏭 _*EP:*_ ${estoqueSegGTPC > 0 ? `${estoqueSegGTPC} ${unidade}` : "❌"}`
        ].join('\n');

        const resposta = `📦 _*Produto Encontrado!*_\n\n` +
          `📌  _*Código:*_ ${produto.id}\n` +
          `📃  _*Texto breve:*_ ${produto.texto_breve}\n` +
          `📝  _*Descrição completa:*_ ${produto.texto_completo}\n\n` +
          `📍  _*Estoque por Empresa:*_\n${estoqueInfo}\n\n` +
          `⚠️  _*Estoque de Segurança:*_\n${estoqueSegInfo}`;

        await sock.sendMessage(msg.key.remoteJid, { text: resposta });

      } else {
        const erroApi = response.data?.message || "Servidor Protheus indisponível.";
        await sock.sendMessage(msg.key.remoteJid, { text: `\nℹ️ ${erroApi}` });
      }
    } catch (error) {
      console.error("❌ Erro na consulta ao produto:", error);
      await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ Erro de comunicação com o sistema Protheus." });
    }
  });
}

startBot();

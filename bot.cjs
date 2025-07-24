const crypto = require('crypto');
const baileys = require('@whiskeysockets/baileys');
const axios = require('axios');
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
  const { state, saveCreds } = await baileys.useMultiFileAuthState('auth_info');

  const sock = baileys.default({
    auth: state,
    printQRInTerminal: true,  // <-- Mostra o QR code no terminal
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📲 Escaneie o QR Code acima com o WhatsApp.');
    }

    if (connection === 'close') {
      const reason = baileys.DisconnectReason?.loggedOut || (lastDisconnect?.error ? new baileys.Boom(lastDisconnect.error).output.statusCode : null);
      console.log('Conexão fechada:', reason);
      if (reason !== baileys.DisconnectReason.loggedOut) {
        console.log('Tentando reconectar...');
        startBot();
      } else {
        console.log('Sessão desconectada. Apague a pasta auth_info para reiniciar login.');
      }
    } else if (connection === 'open') {
      console.log('✅ Bot conectado com sucesso!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

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
      const response = await axios.get(`https://utepecem.com/sigma/api/getProduto/${codigoProduto}/todas/xEQ2y0SZufH5L1wJ2K98MVqCtjU8Sq6Z`);

      if (response.status === 200 && response.data.sucess && response.data.data) {
        const produto = response.data.data;
        const unidade = produto.unidade;

        // Soma estoque total por empresa
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

        // Estoque de segurança
        const estoqueSegPTPC = await obterEstoqueSeguranca(produto.id, "PTPC");
        const estoqueSegGTPC = await obterEstoqueSeguranca(produto.id, "GTPC");

        const estoqueSegInfo = 
          `🏭 _*PPTM:*_ ${estoqueSegPTPC > 0 ? `${estoqueSegPTPC} ${unidade}` : "❌"}\n` +
          `🏭 _*EP:*_ ${estoqueSegGTPC > 0 ? `${estoqueSegGTPC} ${unidade}` : "❌"}`;

        const resposta = `📦 _*Produto Encontrado!*_\n\n` +
          `📌  _*Código:*_ ${produto.id}\n` +
          `📃  _*Texto breve:*_ ${produto.texto_breve}\n` +
          `📝  _*Descrição completa:*_ ${produto.texto_completo}\n\n` +
          `📍  _*Estoque por Empresa:*_\n${estoqueInfo}\n\n` +
          `⚠️  _*Estoque de Segurança:*_\n${estoqueSegInfo}`;

        await sock.sendMessage(msg.key.remoteJid, { text: resposta });

      } else {
        const erroApi = response.data?.message || "Comunicação com o Protheus está temporariamente offline.";
        await sock.sendMessage(msg.key.remoteJid, { text: `❌ _Produto não encontrado!_\n🛠️ Detalhes: ${erroApi}` });
      }
    } catch (error) {
      console.error("Erro ao consultar produto:", error);
      await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ Erro ao consultar o produto! Comunicação temporariamente offline." });
    }
  });
}
//
startBot();

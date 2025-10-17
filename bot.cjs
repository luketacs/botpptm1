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

// Função para deletar pasta (auth_info)
function deleteFolderRecursive(folderPath) {
  if (fs.existsSync(folderPath)) {
    fs.readdirSync(folderPath).forEach(file => {
      const curPath = path.join(folderPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        deleteFolderRecursive(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(folderPath);
    console.log('🗑️ Pasta auth_info removida automaticamente.');
  }
}

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

// Função principal
async function startBot() {
  console.log('📡 Iniciando bot (preparando auth state)...');

  const authPath = path.join(__dirname, 'auth_info');
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const logger = P({ level: 'info' });

  console.log(`📦 Versão Baileys: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '22.04.4']
  });

  let reconnectAttempts = 0;
  const MAX_RETRIES = 10;

  sock.ev.on('creds.update', saveCreds);

  // Função para reconectar com delay
  const reconnectWithDelay = async (reason) => {
    reconnectAttempts++;
    const delay = 5000;

    console.log(`🔄 Agendando reconexão em ${delay}ms (motivo: ${reason})`);

    if (reconnectAttempts >= MAX_RETRIES) {
      console.log('⚠️ Muitas falhas consecutivas. Resetando sessão...');
      deleteFolderRecursive(authPath);
      reconnectAttempts = 0;
    }

    setTimeout(async () => {
      console.log('🔁 Reiniciando conexão...');
      await startBot();
    }, delay);
  };

  // Monitor de conexão
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📲 Escaneie o QR Code abaixo com o WhatsApp para conectar:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      console.log('✅ Bot conectado com sucesso!');
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`⚠️ Conexão fechada. Código: ${reason} Motivo: ${lastDisconnect?.error?.message || 'Desconhecido'}`);

      if (reason === DisconnectReason.loggedOut) {
        console.log('🛑 Sessão expirada. Gerando novo QR Code...');
        deleteFolderRecursive(authPath);
        await startBot();
      } else {
        await reconnectWithDelay('connection_closed');
      }
    }
  });

  // 🔄 Ping de presença a cada 60s
  setInterval(async () => {
    try {
      await sock.sendPresenceUpdate('available');
      logger.info('💓 Ping de presença enviado.');
    } catch (err) {
      logger.warn('⚠️ Falha ao enviar ping de presença:', err.message);
    }
  }, 60000);

  // 📨 Mensagens recebidas
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
      const agent = new https.Agent({ rejectUnauthorized: false });
      const response = await axios.get(
        `https://utepecem.com/sigma/api/getProduto/${codigoProduto}/todas/xEQ2y0SZufH5L1wJ2K98MVqCtjU8Sq6Z`,
        { httpsAgent: agent, timeout: 15000 }
      );

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
      console.error("❌ Erro na consulta ao produto:", error.message);
      await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ Erro de comunicação com o sistema Protheus." });
    }
  });

  // Tratamento global de erros não capturados
  process.on('unhandledRejection', (reason) => {
    console.error('🚨 Erro não tratado (Promise):', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('🚨 Erro não tratado (Exception):', err);
  });
}

startBot();

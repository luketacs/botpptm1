// bot-stable.js
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

/////////////////////
// CONFIGURATION
/////////////////////
const AUTH_FOLDER = 'auth_info';
const RECONNECT_DELAY = 5000; // ms before attempting reconnection
const INTERNET_PING_INTERVAL = 60 * 1000; // check internet every 60s
const INTERNET_PING_URL = 'https://www.google.com'; // lightweight check
const KEEP_ALIVE_INTERVAL = 30 * 60 * 1000; // 30 minutes
const SIGMA_API_KEY = 'xEQ2y0SZufH5L1wJ2K98MVqCtjU8Sq6Z'; // recomendo mover p/ process.env

/////////////////////
// GLOBAL STATE
/////////////////////
let sock = null;
let isReconnecting = false;
let internetAvailable = true;
let internetCheckerInterval = null;
let keepAliveInterval = null;
let lastConnectionState = null;

/////////////////////
// UTIL: safe log
/////////////////////
function log(...args) {
  console.log(...args);
}

/////////////////////
// UTIL: read security stock
/////////////////////
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
    if (!fs.existsSync(filePath)) {
      log(`❌ Planilha não encontrada: ${filePath}`);
      return 0;
    }

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

/////////////////////
// INTERNET PINGER
/////////////////////
async function checkInternetOnce() {
  try {
    await axios.get(INTERNET_PING_URL, { timeout: 5000 });
    if (!internetAvailable) {
      log('🌐 Internet restabelecida.');
      internetAvailable = true;
    }
    return true;
  } catch (err) {
    if (internetAvailable) {
      log('🌐 Perda da conexão com a internet detectada.');
      internetAvailable = false;
    }
    return false;
  }
}

function startInternetChecker() {
  // já existente, evita duplicar timers
  if (internetCheckerInterval) return;
  // check immediately
  checkInternetOnce();
  internetCheckerInterval = setInterval(checkInternetOnce, INTERNET_PING_INTERVAL);
}

function stopInternetChecker() {
  if (internetCheckerInterval) {
    clearInterval(internetCheckerInterval);
    internetCheckerInterval = null;
  }
}

/////////////////////
// KEEP-ALIVE (presenceSubscribe)
/////////////////////
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(async () => {
    try {
      if (!sock || !sock.user) return;
      await sock.presenceSubscribe(sock.user.id);
      log('💓 Keep-alive enviado com sucesso.');
    } catch (err) {
      log('⚠️ Falha ao enviar keep-alive:', err?.message || err);
    }
  }, KEEP_ALIVE_INTERVAL);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

/////////////////////
// CLEANUP socket
/////////////////////
async function safeCloseSocket() {
  try {
    if (!sock) return;
    try {
      // tenta fechar de forma amigável
      await sock.logout().catch(() => {});
    } catch (e) {
      // ignore
    }
    try {
      sock.ev.removeAllListeners();
    } catch (e) {}
    try {
      sock.ws && sock.ws.close && sock.ws.close();
    } catch (e) {}
    sock = null;
  } catch (e) {
    // ignore
  }
}

/////////////////////
// RECONNECT orchestrator
/////////////////////
function scheduleReconnect(reason = 'unknown') {
  if (isReconnecting) {
    log('🔁 Reconnect já programado — ignorando nova tentativa.');
    return;
  }
  isReconnecting = true;
  log(`🔄 Agendando reconexão em ${RECONNECT_DELAY}ms (motivo: ${reason})`);
  setTimeout(async () => {
    isReconnecting = false;
    try {
      await startBot();
    } catch (err) {
      console.error('❌ Falha ao reiniciar bot:', err);
      // se falhar, agenda nova tentativa
      scheduleReconnect('startBot failed');
    }
  }, RECONNECT_DELAY);
}

/////////////////////
// MAIN: startBot
/////////////////////
async function startBot() {
  try {
    // se já existe sock em execução, fecha antes de criar outro
    if (sock) {
      log('🔁 Fechando socket existente antes de recriar...');
      await safeCloseSocket();
    }

    log('📡 Iniciando bot (preparando auth state)...');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    // fetch version safely
    let version = undefined;
    try {
      const ver = await fetchLatestBaileysVersion();
      version = ver.version;
      log('📦 Versão Baileys:', version.join('.'));
    } catch (err) {
      log('⚠️ Não foi possível obter a versão mais recente do Baileys. Usando versão padrão.');
    }

    sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: 'info' }),
    });

    sock.ev.on('creds.update', saveCreds);

    // connection.update handler
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;

        // log basic transitions
        if (connection && connection !== lastConnectionState) {
          log('🔁 connection.update:', connection);
          lastConnectionState = connection;
        }

        if (qr) {
          log('📲 Escaneie o QR Code abaixo com o WhatsApp para conectar:');
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
          log('✅ Bot conectado com sucesso!');
          // start keep alive and internet checker quando ligado
          startInternetChecker();
          startKeepAlive();
        }

        if (connection === 'close') {
          // determine reason
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reasonStr = (lastDisconnect?.error && lastDisconnect.error?.message) ? lastDisconnect.error.message : statusCode;
          log('⚠️ Conexão fechada. Código:', statusCode, 'Motivo:', reasonStr);

          // se sessão finalizada (logout), apaga auth info e reinicia para gerar QR
          if (statusCode === DisconnectReason.loggedOut) {
            try {
              log('🧹 Sessão expirada ou deslogada. Removendo pasta de autenticação...');
              fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
              log('🗑️ auth_info removida. Iniciando nova sessão (QR sera gerado).');
            } catch (err) {
              console.error('❌ Falha ao remover auth_info:', err);
            } finally {
              stopKeepAlive();
              stopInternetChecker();
              // forçar reconexão imediata (startBot criará novo QR)
              scheduleReconnect('loggedOut');
              return;
            }
          }

          // se foi um erro transiente (internet), tenta reconectar
          // Caso contrário, tenta reconectar controladamente
          scheduleReconnect('connection_closed');
        }
      } catch (err) {
        console.error('❌ Erro no connection.update handler:', err);
      }
    });

    // messages.upsert handler (mantive o comportamento das mensagens)
    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        const msg = messages[0];
        if (!msg || !msg.message) return;

        const text = msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          msg.message.documentMessage?.caption || "";

        const userMessage = String(text || "").trim();

        if (!userMessage.startsWith('!')) return;

        if (userMessage.length !== 9) {
          await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ O código precisa ter exatamente 8 caracteres após o '!'" });
          return;
        }

        const codigoProduto = userMessage.slice(1);

        try {
          const agent = new https.Agent({ rejectUnauthorized: false });
          const response = await axios.get(`https://utepecem.com/sigma/api/getProduto/${codigoProduto}/todas/${SIGMA_API_KEY}`, { httpsAgent: agent, timeout: 10000 });

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
          console.error("❌ Erro na consulta ao produto:", error?.message || error);
          await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ Erro de comunicação com o sistema Protheus." });
        }

      } catch (err) {
        console.error('❌ Erro no messages.upsert handler:', err);
      }
    });

    // start internet checking and keep alive now that socket exists (if open)
    startInternetChecker();
    startKeepAlive();

    log('✅ Socket criado com sucesso. Aguardando eventos...');

  } catch (err) {
    console.error('❌ Falha ao iniciar bot:', err);
    // schedule reconnect para tentar novamente em caso de erro fatal
    scheduleReconnect('start_error');
  }
}

/////////////////////
// GLOBAL PROCESS HANDLERS
/////////////////////
process.on('uncaughtException', (err) => {
  console.error('💥 Erro não tratado (uncaughtException):', err);
  // tenta reiniciar
  scheduleReconnect('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Promise rejeitada sem tratamento:', reason);
  scheduleReconnect('unhandledRejection');
});

// intercepta sinais de shutdown para limpar timers
process.on('SIGINT', async () => {
  log('🛑 Recebido SIGINT. Encerrando com segurança...');
  stopKeepAlive();
  stopInternetChecker();
  await safeCloseSocket();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  log('🛑 Recebido SIGTERM. Encerrando com segurança...');
  stopKeepAlive();
  stopInternetChecker();
  await safeCloseSocket();
  process.exit(0);
});

/////////////////////
// START
/////////////////////
startBot();

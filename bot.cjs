// bot.cjs
global.crypto = require('crypto');
require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const axios = require('axios');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const XLSX = require('xlsx');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const https = require('https');
const { boomify, isBoom } = require('@hapi/boom');
...
if (isBoom(lastDisconnect.error)) {
  reason = lastDisconnect.error.output?.statusCode;
} else {
  const boomified = boomify(lastDisconnect.error);
  reason = boomified.output?.statusCode || 0;
}
// -----------------------------
// CONFIG
// -----------------------------
const CONFIG = {
  MAX_RETRIES: 10,
  RECONNECT_BASE_DELAY: 5000, // base for backoff
  PRESENCE_INTERVAL: 60000,
  API_TIMEOUT: 15000,
  AUTH_PATH: path.join(__dirname, 'auth_info'),
  API_KEY: process.env.API_KEY,
  CACHE_TTL_MS: 10 * 60 * 1000, // 10 min for planilhas and produtos
  PRODUCT_CACHE_TTL_MS: 5 * 60 * 1000, // 5 min per product cache
  WATCHDOG_INTERVAL_MS: 2 * 60 * 1000, // 2min
  WATCHDOG_RESPONSE_TIMEOUT_MS: 10000, // 10s to consider no response
  CACHE_PERSIST_FILE: path.join(__dirname, 'cachePlanilhas.json'),
  LOGS_DIR: path.join(__dirname, 'logs'),
  RESTART_HOUR: 3, // 3:00 AM daily restart
  QUERY_CSV: path.join(__dirname, 'logs', 'consultas.csv')
};

// enforce API key
if (!CONFIG.API_KEY) {
  console.error('❌ API_KEY não configurada. Defina API_KEY no arquivo .env');
  process.exit(1);
}

// -----------------------------
// LOGGING (console + daily file)
// -----------------------------
if (!fs.existsSync(CONFIG.LOGS_DIR)) fs.mkdirSync(CONFIG.LOGS_DIR, { recursive: true });

function dailyLogPath() {
  const d = new Date();
  const name = `bot-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
  return path.join(CONFIG.LOGS_DIR, name);
}

const pinoDest = P.destination({ dest: dailyLogPath(), sync: false });
const logger = P({}, pinoDest);

// also log to console nicely
function clog(...args) { console.log(new Date().toISOString(), ...args); }
function logInfo(...args) { logger.info(...args); clog(...args); }
function logWarn(...args) { logger.warn(...args); clog(...args); }
function logError(...args) { logger.error(...args); clog(...args); }

// -----------------------------
// CACHE: planilhas + produtos + persistence
// -----------------------------
let cachePlanilhas = {
  PTPC: { dados: null, timestamp: 0 },
  GTPC: { dados: null, timestamp: 0 }
};

let productCache = new Map(); // key: codigo, value: { data, ts }

// load persisted cachePlanilhas if exists
async function loadPersistedCache() {
  try {
    if (fs.existsSync(CONFIG.CACHE_PERSIST_FILE)) {
      const raw = await fsp.readFile(CONFIG.CACHE_PERSIST_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.PTPC && parsed.GTPC) {
        cachePlanilhas = parsed;
        logInfo('📥 Cache de planilhas carregado do disco');
      }
    }
  } catch (err) {
    logWarn('⚠️ Falha ao carregar cache persistido:', err.message);
  }
}
async function persistCache() {
  try {
    await fsp.writeFile(CONFIG.CACHE_PERSIST_FILE, JSON.stringify(cachePlanilhas), 'utf8');
    logInfo('💾 Cache de planilhas persistido no disco');
  } catch (err) {
    logWarn('⚠️ Falha ao persistir cache:', err.message);
  }
}

// periodic cleanup of old cache and productCache
function startCacheMaintenance() {
  setInterval(() => {
    const now = Date.now();
    // clear planilha entries older than TTL
    for (const k of ['PTPC', 'GTPC']) {
      if (cachePlanilhas[k].timestamp && (now - cachePlanilhas[k].timestamp > CONFIG.CACHE_TTL_MS)) {
        cachePlanilhas[k] = { dados: null, timestamp: 0 };
        logInfo(`🧹 Cache da planilha ${k} expirou e foi limpo`);
      }
    }
    // clear productCache entries older than TTL
    for (const [key, val] of productCache.entries()) {
      if (now - val.ts > CONFIG.PRODUCT_CACHE_TTL_MS) {
        productCache.delete(key);
      }
    }
    // persist the planilha cache to disk
    persistCache().catch(e => logWarn('persistCache error:', e.message));
  }, 60 * 60 * 1000); // a cada hora
}

// -----------------------------
// UTIL: backup auth_info
// -----------------------------
async function backupAuthInfo() {
  try {
    if (!fs.existsSync(CONFIG.AUTH_PATH)) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(__dirname, 'backup', `auth_info_backup_${timestamp}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.cp(CONFIG.AUTH_PATH, dest, { recursive: true });
    logInfo('📦 Backup auth_info criado em', dest);
  } catch (err) {
    logWarn('⚠️ Falha ao criar backup auth_info:', err.message);
  }
}

// delete auth_info with backup
async function deleteAuthInfoWithBackup() {
  try {
    await backupAuthInfo();
    if (fs.existsSync(CONFIG.AUTH_PATH)) {
      await fsp.rm(CONFIG.AUTH_PATH, { recursive: true, force: true });
      logInfo('🗑️ auth_info removida.');
    }
  } catch (err) {
    logError('❌ Erro ao remover auth_info:', err.message);
  }
}

// -----------------------------
// UTIL: planilha loading with cache
// -----------------------------
async function carregarPlanilhaCache(empresa) {
  try {
    const now = Date.now();
    if (cachePlanilhas[empresa]?.dados && (now - cachePlanilhas[empresa].timestamp < CONFIG.CACHE_TTL_MS)) {
      return cachePlanilhas[empresa].dados;
    }

    let filePath;
    if (empresa === 'PTPC') filePath = path.join(__dirname, 'Estoque Segurança PPTM.xlsx');
    else if (empresa === 'GTPC') filePath = path.join(__dirname, 'Estoque de segurança - Energia Pecém.xlsx');
    else return [];

    if (!fs.existsSync(filePath)) {
      logWarn('⚠️ Planilha não encontrada:', filePath);
      return [];
    }

    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const dados = XLSX.utils.sheet_to_json(sheet);
    cachePlanilhas[empresa] = { dados, timestamp: now };
    logInfo(`📊 Planilha ${empresa} carregada e cacheada`);
    return dados;
  } catch (err) {
    logError('❌ Erro ao carregar planilha:', err.message);
    return [];
  }
}

// obterEstoqueSeguranca with fallback
async function obterEstoqueSeguranca(codigoProduto, empresa) {
  try {
    const dados = await Promise.race([
      carregarPlanilhaCache(empresa),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout planilha')), 5000))
    ]);
    const coluna = empresa === 'PTPC' ? 'EstSeg-PPTM' : 'EstSeg-GTPC';
    const row = dados.find(r => String(r['Codigo']).trim().toLowerCase() === String(codigoProduto).trim().toLowerCase());
    return row?.[coluna] ?? 0;
  } catch (err) {
    logWarn('⚠️ Falha ao obter estoque de segurança. Usando fallback:', err.message);
    return empresa === 'PTPC' ? 10 : 5;
  }
}

// -----------------------------
// PRODUCT API CACHE + CONSULTA
// -----------------------------
async function consultarProdutoAPI(codigoProduto) {
  // check product cache first
  const now = Date.now();
  const cached = productCache.get(codigoProduto);
  if (cached && (now - cached.ts < CONFIG.PRODUCT_CACHE_TTL_MS)) {
    logInfo('📥 Produto retornado do cache local:', codigoProduto);
    return { success: true, data: cached.data };
  }

  try {
    const agent = new https.Agent({ rejectUnauthorized: false });
    const resp = await axios.get(
      `https://utepecem.com/sigma/api/getProduto/${codigoProduto}/todas/${CONFIG.API_KEY}`,
      { httpsAgent: agent, timeout: CONFIG.API_TIMEOUT }
    );
    productCache.set(codigoProduto, { data: resp.data, ts: Date.now() });
    return { success: true, data: resp.data };
  } catch (err) {
    logWarn('❌ Erro na consulta API:', err.message);
    if (err.code === 'ECONNABORTED') return { success: false, error: 'Timeout na consulta ao sistema' };
    if (err.response?.status === 404) return { success: false, error: 'Produto não encontrado' };
    // if we have a cached product that is older than TTL but exists, return it as fallback
    if (cached) {
      logInfo('⚠️ API falhou, retornando dado em cache ainda que vencido:', codigoProduto);
      return { success: true, data: cached.data };
    }
    return { success: false, error: 'Erro de comunicação com o sistema' };
  }
}

// -----------------------------
// CSV log de consultas
// -----------------------------
async function ensureCSV() {
  try {
    if (!fs.existsSync(CONFIG.LOGS_DIR)) await fsp.mkdir(CONFIG.LOGS_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG.QUERY_CSV)) {
      const header = 'data,hora,usuario,codigo,status\n';
      await fsp.writeFile(CONFIG.QUERY_CSV, header, 'utf8');
    }
  } catch (err) {
    logWarn('⚠️ Falha ao garantir CSV de consultas:', err.message);
  }
}
async function registrarConsultaCSV(usuario, codigo, status) {
  try {
    const d = new Date();
    const linha = `${d.toISOString().split('T')[0]},${d.toISOString().split('T')[1].split('.')[0]},${usuario},${codigo},${status}\n`;
    await fsp.appendFile(CONFIG.QUERY_CSV, linha, 'utf8');
  } catch (err) {
    logWarn('⚠️ Falha ao registrar consulta CSV:', err.message);
  }
}

// -----------------------------
// RECONNECT/START logic + WATCHDOG + VERSION check
// -----------------------------
let globalSock = null;
let isStarting = false;
let reconnectAttempts = 0;
let lastBaileysVersion = null;

// backoff delay helper
function getBackoffDelay(attempts) {
  const cap = 6;
  const mult = Math.min(attempts, cap);
  return CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, mult - 1); // exponential
}

// watchdog timer ref
let watchdogTimer = null;
let watchdogPingPending = false;
let watchdogLastPing = 0;

async function safeStopSock() {
  try {
    if (!globalSock) return;
    try { await globalSock.logout().catch(() => {}); } catch {}
    try { globalSock.ev.removeAllListeners(); } catch {}
    try { globalSock.ws && globalSock.ws.close && globalSock.ws.close(); } catch {}
  } finally {
    globalSock = null;
  }
}

async function startBot() {
  if (isStarting) {
    logWarn('🔁 startBot já em progresso, ignorando nova chamada.');
    return;
  }
  isStarting = true;

  try {
    await loadPersistedCache();
    await ensureCSV();

    logInfo('📡 Iniciando bot (preparando auth state)...');

    // fetch version and notify if changed
    let versionObj;
    try {
      versionObj = await fetchLatestBaileysVersion();
      const ver = versionObj.version;
      const verStr = ver.join('.');
      if (lastBaileysVersion && lastBaileysVersion !== verStr) {
        logWarn('🔔 Nova versão do Baileys detectada:', verStr, ' — considere atualizar.');
      }
      lastBaileysVersion = verStr;
    } catch (err) {
      logWarn('⚠️ Não foi possível obter a versão mais recente do Baileys:', err.message);
    }

    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_PATH);
    const sock = makeWASocket({
      version: versionObj?.version,
      auth: state,
      logger: P({ level: 'info' }),
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '22.04.4']
    });

    globalSock = sock;
    reconnectAttempts = 0;

    sock.ev.on('creds.update', saveCreds);

    // connection.update
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          logInfo('📲 Escaneie o QR Code abaixo com o WhatsApp para conectar:');
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
          logInfo('✅ Bot conectado com sucesso!');
          reconnectAttempts = 0;
          // reset watchdog state
          watchdogPingPending = false;
          watchdogLastPing = 0;
        }

        if (connection === 'close') {
          // determine reason using Boom compat
          let reason = 0;
          try {
            if (lastDisconnect?.error) {
              if (lastDisconnect.error.output?.statusCode) reason = lastDisconnect.error.output.statusCode;
              else if (Boom.isBoom(lastDisconnect.error)) reason = lastDisconnect.error.output?.statusCode;
              else { const b = Boom.boomify(lastDisconnect.error); reason = b.output?.statusCode || 0; }
            }
          } catch (e) {
            reason = 0;
          }

          logWarn('⚠️ Conexão fechada. Código:', reason, 'Motivo:', lastDisconnect?.error?.message || 'Desconhecido');

          if (reason === DisconnectReason.loggedOut) {
            logWarn('🛑 Sessão expirada (loggedOut). Realizando backup e reiniciando para novo QR.');
            await deleteAuthInfoWithBackup();
            await safeStopSock();
            // restart fresh
            setTimeout(() => startBot(), 2000);
            return;
          }

          // otherwise schedule reconnect with exponential backoff
          reconnectAttempts++;
          const delay = getBackoffDelay(reconnectAttempts);
          logWarn(`🔄 Tentativa de reconexão #${reconnectAttempts} em ${delay}ms`);
          await safeStopSock();
          setTimeout(() => startBot(), delay);
        }
      } catch (err) {
        logError('❌ Erro em connection.update handler:', err.message || err);
      }
    });

    // messages.upsert
    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        const msg = messages[0];
        if (!msg || !msg.message) return;

        const text = msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          msg.message.videoMessage?.caption ||
          msg.message.documentMessage?.caption || "";

        const userMessage = String(text || '').trim();
        if (!userMessage.startsWith('!')) return; // only respond to commands starting with !

        logInfo('📨 Mensagem recebida:', userMessage, 'de', msg.key.remoteJid);

        // rate limiting per user - simple token bucket like
        // reuse your earlier function logic (kept simple here)
        const remetente = msg.key.remoteJid;
        // using a Map with small structure
        if (!global.rateLimiter) global.rateLimiter = new Map();
        const now = Date.now();
        const uso = global.rateLimiter.get(remetente) || { count: 0, lastTime: 0 };
        if (now - uso.lastTime > 1000) {
          uso.count = 1;
          uso.lastTime = now;
        } else {
          uso.count++;
        }
        global.rateLimiter.set(remetente, uso);
        if (uso.count > 5) {
          await sock.sendMessage(remetente, { text: "⏳ Muitas consultas rápidas! Aguarde 1 segundo entre as consultas." });
          await registrarConsultaCSV(remetente, userMessage.slice(1), 'RATE_LIMIT');
          return;
        }

        // commands: !ajuda / !help / !status handled minimally but still keep only !-prefix behaviour
        if (userMessage === '!ajuda' || userMessage === '!help') {
          const ajuda = `📚 *COMANDOS DISPONÍVEIS*
          
!12345678 - Consulta produto por código (8 dígitos)
!ajuda - Mostra esta mensagem
!status - Verifica status do bot

_Desenvolvido para UTE Pecém_`;
          await sock.sendMessage(remetente, { text: ajuda });
          return;
        }
        if (userMessage === '!status') {
          const status = `🤖 *STATUS DO BOT*
          
✅ Conectado: ${sock.user ? 'Sim' : 'Não'}
🔄 Tentativas de reconexão: ${reconnectAttempts}
📊 Uso de memória: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB
💾 Cache PTPC: ${cachePlanilhas.PTPC?.dados ? '✅' : '❌'}, GTPC: ${cachePlanilhas.GTPC?.dados ? '✅' : '❌'}
`;
          await sock.sendMessage(remetente, { text: status });
          return;
        }

        // validate product code: 8 digits numeric
        const codigoProduto = userMessage.slice(1);
        if (!/^\d{8}$/.test(codigoProduto)) {
          await sock.sendMessage(remetente, { text: "⚠️ *FORMATO INVÁLIDO!*\n\nUse: !12345678 (8 dígitos numéricos)\nExemplo: !00012345" });
          await registrarConsultaCSV(remetente, codigoProduto, 'INVALID_FORMAT');
          return;
        }

        // indicate composing
        await sock.sendPresenceUpdate('composing', remetente);

        // query API (with cache fallback)
        const consulta = await consultarProdutoAPI(codigoProduto);
        if (!consulta.success) {
          await sock.sendMessage(remetente, { text: `❌ *ERRO NA CONSULTA*\n\n${consulta.error}` });
          await registrarConsultaCSV(remetente, codigoProduto, 'API_ERROR');
          return;
        }

        if (consulta.data.success && consulta.data.data) {
          const produto = consulta.data.data;
          const unidade = produto.unidade;
          const estoques = { PTPC: 0, GTPC: 0 };
          produto.estoques.forEach(e => {
            const qtd = parseFloat(e.qAtual) || 0;
            if (e.empresa === 'PTPC') estoques.PTPC += qtd;
            if (e.empresa === 'GTPC') estoques.GTPC += qtd;
          });

          // get estoque de segurança (from planilhas)
          const estoqueSegPTPC = await obterEstoqueSeguranca(produto.id, 'PTPC');
          const estoqueSegGTPC = await obterEstoqueSeguranca(produto.id, 'GTPC');

          // format response to keep your current layout
          const estoqueInfo = [
            `🏭 _*PPTM:*_ ${estoques.PTPC > 0 ? `${estoques.PTPC} ${unidade}` : "❌"}`,
            `🏭 _*EP:*_ ${estoques.GTPC > 0 ? `${estoques.GTPC} ${unidade}` : "❌"}`
          ].join('\n');

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

          await sock.sendMessage(remetente, { text: resposta });
          await registrarConsultaCSV(remetente, codigoProduto, 'SUCCESS');
        } else {
          const erroApi = consulta.data?.message || 'Produto não encontrado no sistema.';
          await sock.sendMessage(remetente, { text: `❌ *PRODUTO NÃO ENCONTRADO*\n\nCódigo: ${codigoProduto}\nMotivo: ${erroApi}` });
          await registrarConsultaCSV(remetente, codigoProduto, 'NOT_FOUND');
        }
      } catch (err) {
        logError('❌ Erro no messages.upsert handler:', err.message || err);
      } finally {
        try { await sock.sendPresenceUpdate('paused', msg.key.remoteJid); } catch {}
      }
    });

    // presence / keep-alive ping
    const presenceInterval = setInterval(async () => {
      try {
        if (globalSock && globalSock.user) {
          await globalSock.sendPresenceUpdate('available');
          logInfo('💓 Ping de presença enviado.');
        }
      } catch (err) {
        logWarn('⚠️ Falha ao enviar ping de presença:', err.message || err);
      }
    }, CONFIG.PRESENCE_INTERVAL);

    // START WATCHDOG
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(async () => {
      try {
        if (!globalSock || !globalSock.ws) return;
        // if readyState not OPEN (1), trigger restart
        const ready = globalSock.ws.readyState;
        if (ready !== 1) {
          logWarn('⚠️ Watchdog detectou WebSocket não aberto (readyState=' + ready + '). Reiniciando...');
          clearInterval(presenceInterval);
          await safeStopSock();
          setTimeout(() => startBot(), 2000);
          return;
        }
        // send a small presence ping and mark pending
        watchdogPingPending = true;
        watchdogLastPing = Date.now();
        try {
          await globalSock.sendPresenceUpdate('available');
        } catch (e) {
          logWarn('⚠️ Watchdog ping falhou:', e.message || e);
        }
        // if ping still pending after response timeout, restart
        setTimeout(async () => {
          if (watchdogPingPending && (Date.now() - watchdogLastPing) > CONFIG.WATCHDOG_RESPONSE_TIMEOUT_MS) {
            logWarn('⚠️ Watchdog: ping sem resposta em', CONFIG.WATCHDOG_RESPONSE_TIMEOUT_MS, 'ms. Reiniciando...');
            clearInterval(presenceInterval);
            await safeStopSock();
            setTimeout(() => startBot(), 2000);
          }
        }, CONFIG.WATCHDOG_RESPONSE_TIMEOUT_MS + 100);
      } catch (e) {
        logWarn('⚠️ Watchdog erro:', e.message || e);
      }
    }, CONFIG.WATCHDOG_INTERVAL_MS);

    // on any incoming event we can mark ping responded
    sock.ev.on('chats.set', () => {
      watchdogPingPending = false;
    });
    sock.ev.on('contacts.set', () => {
      watchdogPingPending = false;
    });
    sock.ev.on('messages.upsert', () => {
      watchdogPingPending = false;
    });

    // GLOBAL ERROR HANDLERS
    process.off('unhandledRejection', global.unhandledRejectionHandler);
    process.off('uncaughtException', global.uncaughtExceptionHandler);
    global.unhandledRejectionHandler = (reason) => {
      logError('🚨 Erro não tratado (Promise):', reason);
    };
    global.uncaughtExceptionHandler = (err) => {
      logError('🚨 Erro não tratado (Exception):', err);
    };
    process.on('unhandledRejection', global.unhandledRejectionHandler);
    process.on('uncaughtException', global.uncaughtExceptionHandler);

    // return sock
    isStarting = false;
    return sock;
  } catch (err) {
    isStarting = false;
    reconnectAttempts++;
    const delay = getBackoffDelay(reconnectAttempts);
    logError('❌ Falha ao iniciar bot:', err.message || err, 'Tentando novamente em', delay, 'ms');
    await safeStopSock();
    setTimeout(() => startBot(), delay);
  }
}

// -----------------------------
// DAILY RESTART AT 03:00
// -----------------------------
function scheduleDailyRestart() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(CONFIG.RESTART_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next.getTime() - now.getTime();
  logInfo('🔁 Próximo reinício programado em (ms):', delay);
  setTimeout(() => {
    logInfo('🔁 Reinício diário acionado. Encerrando processo para PM2 reiniciar.');
    process.exit(0);
  }, delay);
  // schedule again in 24h after firing
  setTimeout(scheduleDailyRestart, delay + 1000);
}

// -----------------------------
// STARTUP
// -----------------------------
(async () => {
  try {
    await loadPersistedCache();
    startCacheMaintenance();
    await startBot();
    scheduleDailyRestart();
    logInfo('✅ Bot iniciado com todas as melhorias.');
  } catch (err) {
    logError('❌ Erro na inicialização:', err.message || err);
    process.exit(1);
  }
})();

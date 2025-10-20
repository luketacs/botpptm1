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
const Boom = require('@hapi/boom');

// -----------------------------
// CONFIG
// -----------------------------
const CONFIG = {
  MAX_RETRIES: 10,
  RECONNECT_BASE_DELAY: 5000,
  PRESENCE_INTERVAL: 60000,
  API_TIMEOUT: 15000,
  AUTH_PATH: path.join(__dirname, 'auth_info'),
  API_KEY: process.env.API_KEY,
  CACHE_TTL_MS: 10 * 60 * 1000,
  PRODUCT_CACHE_TTL_MS: 5 * 60 * 1000,
  WATCHDOG_INTERVAL_MS: 2 * 60 * 1000,
  WATCHDOG_RESPONSE_TIMEOUT_MS: 10000,
  CACHE_PERSIST_FILE: path.join(__dirname, 'cachePlanilhas.json'),
  LOGS_DIR: path.join(__dirname, 'logs'),
  RESTART_HOUR: 3,
  QUERY_CSV: path.join(__dirname, 'logs', 'consultas.csv')
};

// enforce API key
if (!CONFIG.API_KEY) {
  console.error('❌ API_KEY não configurada. Defina API_KEY no arquivo .env');
  process.exit(1);
}

// -----------------------------
// LOGGING
// -----------------------------
if (!fs.existsSync(CONFIG.LOGS_DIR)) fs.mkdirSync(CONFIG.LOGS_DIR, { recursive: true });

function dailyLogPath() {
  const d = new Date();
  const name = `bot-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
  return path.join(CONFIG.LOGS_DIR, name);
}

const pinoDest = P.destination({ dest: dailyLogPath(), sync: false });
const logger = P({}, pinoDest);
const clog = (...args) => console.log(new Date().toISOString(), ...args);
const logInfo = (...a) => { logger.info(...a); clog(...a); };
const logWarn = (...a) => { logger.warn(...a); clog(...a); };
const logError = (...a) => { logger.error(...a); clog(...a); };

// -----------------------------
// CACHE
// -----------------------------
let cachePlanilhas = { PTPC: { dados: null, timestamp: 0 }, GTPC: { dados: null, timestamp: 0 } };
let productCache = new Map();

async function loadPersistedCache() {
  try {
    if (fs.existsSync(CONFIG.CACHE_PERSIST_FILE)) {
      const raw = await fsp.readFile(CONFIG.CACHE_PERSIST_FILE, 'utf8');
      cachePlanilhas = JSON.parse(raw);
      logInfo('📥 Cache de planilhas carregado do disco');
    }
  } catch (err) { logWarn('⚠️ Falha ao carregar cache persistido:', err.message); }
}
async function persistCache() {
  try {
    await fsp.writeFile(CONFIG.CACHE_PERSIST_FILE, JSON.stringify(cachePlanilhas), 'utf8');
  } catch (err) { logWarn('⚠️ Falha ao persistir cache:', err.message); }
}
function startCacheMaintenance() {
  setInterval(() => {
    const now = Date.now();
    for (const k of ['PTPC', 'GTPC']) {
      if (cachePlanilhas[k].timestamp && (now - cachePlanilhas[k].timestamp > CONFIG.CACHE_TTL_MS)) {
        cachePlanilhas[k] = { dados: null, timestamp: 0 };
        logInfo(`🧹 Cache da planilha ${k} expirou`);
      }
    }
    for (const [key, val] of productCache.entries()) {
      if (now - val.ts > CONFIG.PRODUCT_CACHE_TTL_MS) productCache.delete(key);
    }
    persistCache().catch(() => {});
  }, 60 * 60 * 1000);
}

// -----------------------------
// AUTH INFO
// -----------------------------
async function backupAuthInfo() {
  try {
    if (!fs.existsSync(CONFIG.AUTH_PATH)) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(__dirname, 'backup', `auth_info_backup_${timestamp}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.cp(CONFIG.AUTH_PATH, dest, { recursive: true });
    logInfo('📦 Backup auth_info criado em', dest);
  } catch (err) { logWarn('⚠️ Falha ao criar backup auth_info:', err.message); }
}
async function deleteAuthInfoWithBackup() {
  try {
    await backupAuthInfo();
    if (fs.existsSync(CONFIG.AUTH_PATH))
      await fsp.rm(CONFIG.AUTH_PATH, { recursive: true, force: true });
  } catch (err) { logError('❌ Erro ao remover auth_info:', err.message); }
}

// -----------------------------
// PLANILHAS
// -----------------------------
async function carregarPlanilhaCache(empresa) {
  try {
    const now = Date.now();
    if (cachePlanilhas[empresa]?.dados && (now - cachePlanilhas[empresa].timestamp < CONFIG.CACHE_TTL_MS))
      return cachePlanilhas[empresa].dados;

    const filePath = empresa === 'PTPC'
      ? path.join(__dirname, 'Estoque Segurança PPTM.xlsx')
      : path.join(__dirname, 'Estoque de segurança - Energia Pecém.xlsx');

    if (!fs.existsSync(filePath)) return [];
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const dados = XLSX.utils.sheet_to_json(sheet);
    cachePlanilhas[empresa] = { dados, timestamp: now };
    return dados;
  } catch { return []; }
}
async function obterEstoqueSeguranca(codigo, empresa) {
  try {
    const dados = await Promise.race([
      carregarPlanilhaCache(empresa),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 5000))
    ]);
    const coluna = empresa === 'PTPC' ? 'EstSeg-PPTM' : 'EstSeg-GTPC';
    const row = dados.find(r => String(r['Codigo']).trim() === String(codigo).trim());
    return row?.[coluna] ?? 0;
  } catch { return 0; }
}

// -----------------------------
// CONSULTA API
// -----------------------------
async function consultarProdutoAPI(codigo) {
  const cached = productCache.get(codigo);
  const now = Date.now();
  if (cached && (now - cached.ts < CONFIG.PRODUCT_CACHE_TTL_MS))
    return { success: true, data: cached.data };

  try {
    const agent = new https.Agent({ rejectUnauthorized: false });
    const resp = await axios.get(
      `https://utepecem.com/sigma/api/getProduto/${codigo}/todas/${CONFIG.API_KEY}`,
      { httpsAgent: agent, timeout: CONFIG.API_TIMEOUT }
    );
    productCache.set(codigo, { data: resp.data, ts: now });
    return { success: true, data: resp.data };
  } catch (err) {
    if (cached) return { success: true, data: cached.data };
    return { success: false, error: err.message };
  }
}

// -----------------------------
// CSV
// -----------------------------
async function ensureCSV() {
  if (!fs.existsSync(CONFIG.LOGS_DIR)) await fsp.mkdir(CONFIG.LOGS_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG.QUERY_CSV))
    await fsp.writeFile(CONFIG.QUERY_CSV, 'data,hora,usuario,codigo,status\n');
}
async function registrarConsultaCSV(usuario, codigo, status) {
  const d = new Date();
  const linha = `${d.toISOString().split('T')[0]},${d.toISOString().split('T')[1].split('.')[0]},${usuario},${codigo},${status}\n`;
  await fsp.appendFile(CONFIG.QUERY_CSV, linha);
}

// -----------------------------
// CORE
// -----------------------------
let globalSock = null;
let reconnectAttempts = 0;
let isStarting = false;
let lastBaileysVersion = null;
let watchdogTimer = null;

const getBackoffDelay = n => CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, Math.min(n, 6));

async function safeStopSock() {
  try {
    if (!globalSock) return;
    try { await globalSock.logout().catch(() => {}); } catch {}
    try { globalSock.ev.removeAllListeners(); } catch {}
    try { globalSock.ws?.close(); } catch {}
  } finally { globalSock = null; }
}

async function startBot() {
  if (isStarting) return;
  isStarting = true;
  try {
    await loadPersistedCache();
    await ensureCSV();
    let versionObj;
    try {
      versionObj = await fetchLatestBaileysVersion();
      lastBaileysVersion = versionObj.version.join('.');
    } catch {}

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

    sock.ev.on('connection.update', async (update) => {
      try {
        if (!update) return;
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          logInfo('📲 Escaneie o QR Code abaixo:');
          qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') logInfo('✅ Bot conectado com sucesso!');
        if (connection === 'close') {
          let reasonCode = 0;
          try {
            const err = lastDisconnect?.error;
            if (Boom.isBoom(err)) reasonCode = err.output.statusCode;
            else if (err?.output?.statusCode) reasonCode = err.output.statusCode;
          } catch {}
          logWarn('⚠️ Conexão fechada. Código:', reasonCode);

          if (reasonCode === DisconnectReason.loggedOut) {
            logWarn('🛑 Sessão expirada. Limpando auth...');
            await deleteAuthInfoWithBackup();
          }
          await safeStopSock();
          const delay = getBackoffDelay(++reconnectAttempts);
          setTimeout(() => startBot(), delay);
        }
      } catch (err) { logError('Erro em connection.update:', err.message); }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        const msg = messages?.[0];
        if (!msg?.message) return;
        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption || "";
        const conteudo = text.trim();
        if (!conteudo.startsWith('!')) return;

        const jid = msg.key.remoteJid;
        const comando = conteudo.slice(1);
        logInfo(`📨 ${jid} => ${conteudo}`);

        if (conteudo === '!ajuda' || conteudo === '!help') {
          const ajuda = `📚 *COMANDOS DISPONÍVEIS*\n\n!12345678 - Consulta produto\n!status - Status do bot`;
          await sock.sendMessage(jid, { text: ajuda });
          return;
        }
        if (conteudo === '!status') {
          const status = `🤖 *BOT STATUS*\nConectado: ${!!sock.user}\nTentativas: ${reconnectAttempts}`;
          await sock.sendMessage(jid, { text: status });
          return;
        }
        if (!/^\d{8}$/.test(comando)) {
          await sock.sendMessage(jid, { text: '⚠️ Use: !12345678 (8 dígitos)' });
          return;
        }

        await sock.sendPresenceUpdate('composing', jid);
        const consulta = await consultarProdutoAPI(comando);
        if (!consulta.success) {
          await sock.sendMessage(jid, { text: `❌ Erro: ${consulta.error}` });
          return;
        }

        const produto = consulta.data.data;
        if (!produto) {
          await sock.sendMessage(jid, { text: '❌ Produto não encontrado.' });
          return;
        }

        const unidade = produto.unidade;
        const estoques = { PTPC: 0, GTPC: 0 };
        produto.estoques.forEach(e => {
          const qtd = parseFloat(e.qAtual) || 0;
          if (e.empresa === 'PTPC') estoques.PTPC += qtd;
          if (e.empresa === 'GTPC') estoques.GTPC += qtd;
        });

        const segPTPC = await obterEstoqueSeguranca(produto.id, 'PTPC');
        const segGTPC = await obterEstoqueSeguranca(produto.id, 'GTPC');

        const texto = `📦 *Produto Encontrado!*\n\n` +
          `Código: ${produto.id}\n` +
          `Descrição: ${produto.texto_breve}\n\n` +
          `🏭 PPTM: ${estoques.PTPC} ${unidade} (seg: ${segPTPC})\n` +
          `🏭 EP: ${estoques.GTPC} ${unidade} (seg: ${segGTPC})`;
        await sock.sendMessage(jid, { text: texto });
      } catch (err) { logError('Erro no messages.upsert:', err.message); }
    });

    setInterval(async () => {
      try {
        if (globalSock?.user) await globalSock.sendPresenceUpdate('available');
      } catch {}
    }, CONFIG.PRESENCE_INTERVAL);

    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(async () => {
      if (!globalSock?.ws) return;
      if (globalSock.ws.readyState !== 1) {
        logWarn('⚠️ Watchdog detectou WS fechado. Reiniciando...');
        await safeStopSock();
        setTimeout(() => startBot(), 2000);
      }
    }, CONFIG.WATCHDOG_INTERVAL_MS);

    isStarting = false;
  } catch (err) {
    logError('❌ Falha ao iniciar:', err.message);
    isStarting = false;
    const delay = getBackoffDelay(++reconnectAttempts);
    setTimeout(() => startBot(), delay);
  }
}

// -----------------------------
// RESTART DIÁRIO
// -----------------------------
function scheduleDailyRestart() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(CONFIG.RESTART_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  logInfo('🔁 Reinício programado para as', next.toLocaleString());
  setTimeout(() => {
    logInfo('🔁 Reinício diário iniciado.');
    process.exit(0);
  }, delay);
}

// -----------------------------
// START
// -----------------------------
(async () => {
  await loadPersistedCache();
  startCacheMaintenance();
  await startBot();
  scheduleDailyRestart();
  logInfo('✅ Bot iniciado com sucesso!');
})();

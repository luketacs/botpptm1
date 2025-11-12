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
const { HttpsProxyAgent } = require('https-proxy-agent');
const { boomify, isBoom } = require('@hapi/boom');

// -----------------------------
// CONFIGURAÇÃO AVANÇADA
// -----------------------------
const CONFIG = {
  MAX_RETRIES: 10,
  RECONNECT_BASE_DELAY: 5000,
  PRESENCE_INTERVAL: 60000,
  API_TIMEOUT: 30000,
  AUTH_PATH: path.join(__dirname, 'auth_info'),
  API_KEY: process.env.API_KEY,
  CACHE_TTL_MS: 10 * 60 * 1000,
  PRODUCT_CACHE_TTL_MS: 5 * 60 * 1000,
  CACHE_PERSIST_FILE: path.join(__dirname, 'cachePlanilhas.json'),
  LOGS_DIR: path.join(__dirname, 'logs'),
  QUERY_CSV: path.join(__dirname, 'logs', 'consultas.csv'),
  
  // Sistema de administradores
  ADMIN_NUMBERS: process.env.ADMIN_NUMBERS ? 
    process.env.ADMIN_NUMBERS.split(',').map(num => {
      const cleanNum = num.trim().replace(/\D/g, '');
      return `${cleanNum}@s.whatsapp.net`;
    }) : [],
  
  // Configurações de rede
  USE_PROXY: process.env.USE_PROXY === 'true',
  PROXY_CONFIG: process.env.PROXY_HOST ? {
    host: process.env.PROXY_HOST,
    port: process.env.PROXY_PORT || 8080,
    auth: process.env.PROXY_USER ? {
      username: process.env.PROXY_USER,
      password: process.env.PROXY_PASS
    } : undefined
  } : null,
  
  // WebSocket
  WS_ORIGIN: 'https://web.whatsapp.com',
  USER_AGENT: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// Validar API Key
if (!CONFIG.API_KEY) {
  console.error('❌ API_KEY não configurada. Defina API_KEY no arquivo .env');
  process.exit(1);
}

// -----------------------------
// SISTEMA DE LOGGING
// -----------------------------
if (!fs.existsSync(CONFIG.LOGS_DIR)) {
  fs.mkdirSync(CONFIG.LOGS_DIR, { recursive: true });
}

function dailyLogPath() {
  const d = new Date();
  const name = `bot-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
  return path.join(CONFIG.LOGS_DIR, name);
}

const pinoDest = P.destination({ dest: dailyLogPath(), sync: false });
const logger = P({ level: process.env.LOG_LEVEL || 'info' }, pinoDest);

function clog(level, ...args) {
  const timestamp = new Date().toISOString();
  const colors = { info: '📘', warn: '📒', error: '📕', debug: '📗' };
  console.log(`${colors[level] || '📘'} ${timestamp}`, ...args);
}

function logInfo(...args) { 
  logger.info(...args); 
  clog('info', ...args); 
}

function logWarn(...args) { 
  logger.warn(...args); 
  clog('warn', ...args); 
}

function logError(...args) { 
  logger.error(...args); 
  clog('error', ...args); 
}

// -----------------------------
// SISTEMA DE ADMINISTRAÇÃO
// -----------------------------
function isAdmin(jid) {
  if (!CONFIG.ADMIN_NUMBERS.length) {
    logWarn('⚠️ Nenhum admin configurado! Configure ADMIN_NUMBERS no .env');
    return false;
  }
  return CONFIG.ADMIN_NUMBERS.includes(jid);
}

async function registrarAcaoAdmin(adminJid, acao, detalhes = '') {
  try {
    const logFile = path.join(CONFIG.LOGS_DIR, 'admin_actions.log');
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ADMIN: ${adminJid} - ${acao} ${detalhes ? '- ' + detalhes : ''}\n`;
    await fsp.appendFile(logFile, entry, 'utf8');
    logInfo(`👑 Ação admin: ${adminJid} - ${acao} ${detalhes}`);
  } catch (err) {
    logWarn('⚠️ Falha ao registrar ação admin:', err.message);
  }
}

// -----------------------------
// SISTEMA DE CACHE
// -----------------------------
let cachePlanilhas = {
  PTPC: { dados: null, timestamp: 0 },
  GTPC: { dados: null, timestamp: 0 }
};

let productCache = new Map();
let statistics = {
  totalQueries: 0,
  successfulQueries: 0,
  failedQueries: 0,
  cacheHits: 0,
  apiCalls: 0
};

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
  } catch (err) {
    logWarn('⚠️ Falha ao persistir cache:', err.message);
  }
}

function startCacheMaintenance() {
  setInterval(() => {
    const now = Date.now();
    let cleaned = false;

    for (const k of ['PTPC', 'GTPC']) {
      if (cachePlanilhas[k].timestamp && (now - cachePlanilhas[k].timestamp > CONFIG.CACHE_TTL_MS)) {
        cachePlanilhas[k] = { dados: null, timestamp: 0 };
        logInfo(`🧹 Cache da planilha ${k} expirou e foi limpo`);
        cleaned = true;
      }
    }

    for (const [key, val] of productCache.entries()) {
      if (now - val.ts > CONFIG.PRODUCT_CACHE_TTL_MS) {
        productCache.delete(key);
        cleaned = true;
      }
    }

    if (cleaned) {
      persistCache().catch(e => logWarn('Erro ao persistir cache:', e.message));
    }
  }, 30 * 60 * 1000);
}

// -----------------------------
// SISTEMA DE REDE
// -----------------------------
async function createNetworkAgent() {
  try {
    if (CONFIG.USE_PROXY && CONFIG.PROXY_CONFIG) {
      logInfo('🔌 Usando proxy corporativo:', CONFIG.PROXY_CONFIG.host);
      return new HttpsProxyAgent(CONFIG.PROXY_CONFIG);
    }
    return new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      timeout: CONFIG.API_TIMEOUT
    });
  } catch (err) {
    logWarn('⚠️ Falha ao criar agent de rede:', err.message);
    return new https.Agent({ rejectUnauthorized: false });
  }
}

// -----------------------------
// BACKUP E AUTH
// -----------------------------
async function backupAuthInfo() {
  try {
    if (!fs.existsSync(CONFIG.AUTH_PATH)) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(__dirname, 'backup');
    const dest = path.join(backupDir, `auth_info_backup_${timestamp}`);
    await fsp.mkdir(backupDir, { recursive: true });
    await fsp.cp(CONFIG.AUTH_PATH, dest, { recursive: true });
    logInfo('📦 Backup auth_info criado');
    return dest;
  } catch (err) {
    logWarn('⚠️ Falha ao criar backup auth_info:', err.message);
    return null;
  }
}

async function deleteAuthInfoWithBackup() {
  try {
    await backupAuthInfo();
    if (fs.existsSync(CONFIG.AUTH_PATH)) {
      await fsp.rm(CONFIG.AUTH_PATH, { recursive: true, force: true });
      logInfo('🗑️ auth_info removida com backup');
      return true;
    }
    return false;
  } catch (err) {
    logError('❌ Erro ao remover auth_info:', err.message);
    return false;
  }
}

// -----------------------------
// PLANILHAS
// -----------------------------
async function carregarPlanilhaCache(empresa) {
  try {
    const now = Date.now();
    const cached = cachePlanilhas[empresa];
    
    if (cached?.dados && (now - cached.timestamp < CONFIG.CACHE_TTL_MS)) {
      return cached.dados;
    }

    let filePath;
    if (empresa === 'PTPC') {
      filePath = path.join(__dirname, 'Estoque Segurança PPTM.xlsx');
    } else if (empresa === 'GTPC') {
      filePath = path.join(__dirname, 'Estoque de segurança - Energia Pecém.xlsx');
    } else {
      return [];
    }

    if (!fs.existsSync(filePath)) {
      logWarn('⚠️ Planilha não encontrada:', filePath);
      return cached?.dados || [];
    }

    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const dados = XLSX.utils.sheet_to_json(sheet);
    
    cachePlanilhas[empresa] = { dados, timestamp: now };
    logInfo(`📊 Planilha ${empresa} carregada: ${dados.length} registros`);
    return dados;
  } catch (err) {
    logError('❌ Erro ao carregar planilha:', err.message);
    return cachePlanilhas[empresa]?.dados || [];
  }
}

async function obterEstoqueSeguranca(codigoProduto, empresa) {
  try {
    const dados = await Promise.race([
      carregarPlanilhaCache(empresa),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 8000))
    ]);
    
    const coluna = empresa === 'PTPC' ? 'EstSeg-PPTM' : 'EstSeg-GTPC';
    const row = dados.find(r => 
      String(r['Codigo']).trim().toLowerCase() === String(codigoProduto).trim().toLowerCase()
    );
    
    return row?.[coluna] ?? 0;
  } catch (err) {
    logWarn(`⚠️ Fallback estoque segurança ${empresa}:`, err.message);
    return empresa === 'PTPC' ? 10 : 5;
  }
}

// -----------------------------
// API DE PRODUTOS
// -----------------------------
async function consultarProdutoAPI(codigoProduto) {
  statistics.totalQueries++;
  
  const now = Date.now();
  const cached = productCache.get(codigoProduto);
  if (cached && (now - cached.ts < CONFIG.PRODUCT_CACHE_TTL_MS)) {
    statistics.cacheHits++;
    return { success: true, data: cached.data, source: 'cache' };
  }

  try {
    statistics.apiCalls++;
    const agent = await createNetworkAgent();
    
    const response = await axios.get(
      `https://utepecem.com/sigma/api/getProduto/${codigoProduto}/todas/${CONFIG.API_KEY}`,
      {
        httpsAgent: agent,
        timeout: CONFIG.API_TIMEOUT,
        headers: {
          'User-Agent': CONFIG.USER_AGENT,
          'Accept': 'application/json'
        }
      }
    );

    productCache.set(codigoProduto, { data: response.data, ts: Date.now() });
    statistics.successfulQueries++;
    return { success: true, data: response.data, source: 'api' };
  } catch (err) {
    statistics.failedQueries++;
    
    logWarn('❌ Erro na consulta API:', err.code, err.message);
    
    if (cached) {
      logInfo('🔄 Usando cache expirado como fallback:', codigoProduto);
      return { success: true, data: cached.data, source: 'cache_expired' };
    }
    
    if (err.code === 'ECONNABORTED') {
      return { success: false, error: 'Timeout na consulta ao sistema' };
    }
    if (err.response?.status === 404) {
      return { success: false, error: 'Produto não encontrado' };
    }
    
    return { success: false, error: 'Erro de comunicação com o sistema' };
  }
}

// -----------------------------
// LOGGING CSV
// -----------------------------
async function ensureCSV() {
  try {
    if (!fs.existsSync(CONFIG.LOGS_DIR)) {
      await fsp.mkdir(CONFIG.LOGS_DIR, { recursive: true });
    }
    if (!fs.existsSync(CONFIG.QUERY_CSV)) {
      const header = 'data,hora,usuario,codigo,status,origem\n';
      await fsp.writeFile(CONFIG.QUERY_CSV, header, 'utf8');
    }
  } catch (err) {
    logWarn('⚠️ Falha ao garantir CSV de consultas:', err.message);
  }
}

async function registrarConsultaCSV(usuario, codigo, status, origem = 'api') {
  try {
    const d = new Date();
    const linha = `${d.toISOString().split('T')[0]},${d.toISOString().split('T')[1].split('.')[0]},${usuario},${codigo},${status},${origem}\n`;
    await fsp.appendFile(CONFIG.QUERY_CSV, linha, 'utf8');
  } catch (err) {
    logWarn('⚠️ Falha ao registrar consulta CSV:', err.message);
  }
}

// -----------------------------
// NÚCLEO DO BOT WHATSAPP
// -----------------------------
let globalSock = null;
let isStarting = false;
let reconnectAttempts = 0;
let presenceInterval = null;
const rateLimiter = new Map();

function getBackoffDelay(attempts) {
  const cap = 6;
  const mult = Math.min(attempts, cap);
  return CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, mult - 1);
}

async function safeStopSock() {
  try {
    if (!globalSock) return;
    
    if (presenceInterval) {
      clearInterval(presenceInterval);
      presenceInterval = null;
    }
    
    try { await globalSock.logout().catch(() => {}); } catch {}
    try { globalSock.ev.removeAllListeners(); } catch {}
    try { if (globalSock.ws?.close) globalSock.ws.close(); } catch {}
    
  } catch (err) {
    logWarn('⚠️ Erro no safeStopSock:', err.message);
  } finally {
    globalSock = null;
  }
}

function createWASocketCorporate(state, version) {
  const socketOptions = {
    version: version,
    auth: state,
    logger: P({ level: 'fatal' }), // Log mínimo
    printQRInTerminal: true,
    browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
    
    // CONFIGURAÇÕES CRÍTICAS PARA REDE CORPORATIVA
    markOnlineOnConnect: false, // Não enviar presença inicial
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    linkPreviewImageThumbnailWidth: 64,
    
    // TIMEOUTS LONGO
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    maxIdleTimeMs: 120000,
    
    // WEBSOCKET OTIMIZADO
    wsOptions: {
      origin: CONFIG.WS_ORIGIN,
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
      },
      followRedirects: true,
      handshakeTimeout: 45000,
      maxRedirects: 5
    },
    
    // POLÍTICAS DE RETRY
    retryRequestDelayMs: 4000,
    maxRetryCount: 4,
    emitOwnEvents: true,
    defaultQueryTimeoutMs: 60000,
    fireInitQueries: false, // IMPORTANTE: não fazer queries iniciais
    
    // AGENT
    fetchAgent: CONFIG.USE_PROXY && CONFIG.PROXY_CONFIG ? 
      new HttpsProxyAgent(CONFIG.PROXY_CONFIG) : undefined
  };

  return makeWASocket(socketOptions);
}

// -----------------------------
// HANDLER DE COMANDOS
// -----------------------------
async function handleBotCommands(sock, remetente, userMessage) {
  let presenceSent = false;
  
  try {
    logInfo('📨 Comando:', userMessage, 'de', remetente);

    // Rate limiting
    const now = Date.now();
    const userLimit = rateLimiter.get(remetente) || { count: 0, lastTime: 0 };
    
    if (now - userLimit.lastTime > 1000) {
      userLimit.count = 0;
      userLimit.lastTime = now;
    }
    
    userLimit.count++;
    rateLimiter.set(remetente, userLimit);
    
    if (userLimit.count > 5) {
      await sock.sendMessage(remetente, { 
        text: "⏳ Muitas consultas rápidas! Aguarde 1 segundo." 
      });
      await registrarConsultaCSV(remetente, userMessage.slice(1), 'RATE_LIMIT');
      return;
    }

    // Indicar "digitando"
    await sock.sendPresenceUpdate('composing', remetente);
    presenceSent = true;

    // COMANDO: !ajuda
    if (userMessage === '!ajuda' || userMessage === '!help') {
      const isUserAdmin = isAdmin(remetente);
      
      let ajuda = `📚 *COMANDOS DISPONÍVEIS*

!12345678 - Consulta produto (8 dígitos)
!ajuda - Mostra esta mensagem  
!status - Status do bot
!meunumero - Mostra seu número`;

      if (isUserAdmin) {
        ajuda += `

👑 *COMANDOS ADMIN:*
!admin - Informações de admin
!atualizarcache - Atualiza cache
!estatisticas - Estatísticas
!reiniciar - Reinicia o bot`;
      }

      ajuda += `\n\n_Desenvolvido para UTE Pecém_`;
      await sock.sendMessage(remetente, { text: ajuda });
      return;
    }

    // COMANDO: !meunumero
    if (userMessage === '!meunumero') {
      await sock.sendMessage(remetente, { 
        text: `📱 *SEU NÚMERO:*\n\n${remetente}\n\nAdicione no .env como ADMIN_NUMBERS` 
      });
      return;
    }

    // COMANDO: !admin
    if (userMessage === '!admin') {
      const isUserAdmin = isAdmin(remetente);
      const adminInfo = isUserAdmin ? 
        `👑 *VOCÊ É ADMIN*\n\nNúmero: ${remetente}\n\nComandos admin disponíveis.` :
        `❌ *ACESSO NEGADO*\n\nNúmero: ${remetente}\n\nVocê não é administrador.`;
      await sock.sendMessage(remetente, { text: adminInfo });
      return;
    }

    // COMANDO: !status
    if (userMessage === '!status') {
      const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
      const cacheStatusPTPC = cachePlanilhas.PTPC?.dados ? `✅ (${cachePlanilhas.PTPC.dados.length} itens)` : '❌';
      const cacheStatusGTPC = cachePlanilhas.GTPC?.dados ? `✅ (${cachePlanilhas.GTPC.dados.length} itens)` : '❌';
      const isUserAdmin = isAdmin(remetente);
      
      let status = `🤖 *STATUS DO BOT*

✅ Conectado: ${sock.user ? 'Sim' : 'Não'}
🔄 Tentativas: ${reconnectAttempts}
📊 Consultas: ${statistics.totalQueries}
💾 Cache hits: ${statistics.cacheHits}
🧠 Memória: ${memoryUsage}MB
🏭 PTPC: ${cacheStatusPTPC}
🏭 GTPC: ${cacheStatusGTPC}`;

      if (isUserAdmin) {
        const cacheHitRate = statistics.totalQueries > 0 ? 
          ((statistics.cacheHits / statistics.totalQueries) * 100).toFixed(1) : 0;
        status += `\n\n👑 *ADMIN:*\nTaxa cache: ${cacheHitRate}%\nAPI calls: ${statistics.apiCalls}`;
      }

      await sock.sendMessage(remetente, { text: status });
      return;
    }

    // COMANDO: !atualizarcache - Admin
    if (userMessage === '!atualizarcache') {
      if (!isAdmin(remetente)) {
        await sock.sendMessage(remetente, { text: "❌ Acesso negado." });
        return;
      }
      
      const beforePTPC = cachePlanilhas.PTPC.dados?.length || 0;
      const beforeGTPC = cachePlanilhas.GTPC.dados?.length || 0;
      
      cachePlanilhas.PTPC = { dados: null, timestamp: 0 };
      cachePlanilhas.GTPC = { dados: null, timestamp: 0 };
      productCache.clear();
      
      await registrarAcaoAdmin(remetente, 'ATUALIZAR_CACHE', `PTPC:${beforePTPC}->0, GTPC:${beforeGTPC}->0`);
      await sock.sendMessage(remetente, { 
        text: `🔄 *CACHE ATUALIZADO*\n\nCache limpo!\nPTPC: ${beforePTPC} → 0\nGTPC: ${beforeGTPC} → 0` 
      });
      return;
    }

    // COMANDO: !estatisticas - Admin
    if (userMessage === '!estatisticas') {
      if (!isAdmin(remetente)) {
        await sock.sendMessage(remetente, { text: "❌ Acesso negado." });
        return;
      }
      
      const memoryUsage = process.memoryUsage();
      const uptime = Math.floor(process.uptime());
      const cacheHitRate = statistics.totalQueries > 0 ? 
        ((statistics.cacheHits / statistics.totalQueries) * 100).toFixed(1) : 0;
      
      const stats = `📊 *ESTATÍSTICAS - ADMIN*

🤖 *SISTEMA:*
Uptime: ${Math.floor(uptime / 60)}min ${uptime % 60}s
Memória: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB
Reconexões: ${reconnectAttempts}

📈 *CONSULTAS:*
Total: ${statistics.totalQueries}
Sucesso: ${statistics.successfulQueries}
Falhas: ${statistics.failedQueries}
Cache Hits: ${statistics.cacheHits}
Taxa Cache: ${cacheHitRate}%

💾 *CACHE:*
PTPC: ${cachePlanilhas.PTPC.dados?.length || 0} itens
GTPC: ${cachePlanilhas.GTPC.dados?.length || 0} itens
Produtos: ${productCache.size} itens`;

      await registrarAcaoAdmin(remetente, 'ESTATISTICAS', 'Visualizou estatísticas');
      await sock.sendMessage(remetente, { text: stats });
      return;
    }

    // COMANDO: !reiniciar - Admin
    if (userMessage === '!reiniciar') {
      if (!isAdmin(remetente)) {
        await sock.sendMessage(remetente, { text: "❌ Acesso negado." });
        return;
      }
      
      await sock.sendMessage(remetente, { 
        text: "🔄 *REINICIANDO BOT*\n\nReiniciando em 5 segundos..." 
      });
      
      await registrarAcaoAdmin(remetente, 'REINICIAR', 'Solicitou reinicialização');
      
      setTimeout(async () => {
        await safeStopSock();
        await startBot();
      }, 5000);
      return;
    }

    // CONSULTA DE PRODUTO: !12345678
    const codigoProduto = userMessage.slice(1);
    if (!/^\d{8}$/.test(codigoProduto)) {
      await sock.sendMessage(remetente, { 
        text: "⚠️ *FORMATO INVÁLIDO!*\n\nUse: !12345678 (8 dígitos)\nEx: !00012345" 
      });
      await registrarConsultaCSV(remetente, codigoProduto, 'INVALID_FORMAT');
      return;
    }

    // Consultar produto
    const consulta = await consultarProdutoAPI(codigoProduto);
    
    if (!consulta.success) {
      await sock.sendMessage(remetente, { text: `❌ *ERRO:* ${consulta.error}` });
      await registrarConsultaCSV(remetente, codigoProduto, 'API_ERROR', consulta.source);
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

      const [estoqueSegPTPC, estoqueSegGTPC] = await Promise.all([
        obterEstoqueSeguranca(produto.id, 'PTPC'),
        obterEstoqueSeguranca(produto.id, 'GTPC')
      ]);

      const cacheIndicator = consulta.source === 'cache' ? ' (🔄 Cache)' : '';

      const textoBreve    = (produto.texto_breve ?? '').toString().trim();
      const textoCompleto = (produto.texto_completo ?? '').toString().trim();
      
      const resposta = `📦 *Produto Encontrado!*${cacheIndicator}

📌 *Código:* ${produto.id}
📃 *Texto breve:* ${produto.texto_breve}
📃 *Texto completo:* ${textoCompleto || '—'}

📍 *Estoque:*
🏭 *PPTM:* ${estoques.PTPC > 0 ? `${estoques.PTPC} ${unidade}` : "❌"}
🏭 *EP:* ${estoques.GTPC > 0 ? `${estoques.GTPC} ${unidade}` : "❌"}

⚠️ *Estoque Segurança:*
🏭 *PPTM:* ${estoqueSegPTPC > 0 ? `${estoqueSegPTPC} ${unidade}` : "❌"}
🏭 *EP:* ${estoqueSegGTPC > 0 ? `${estoqueSegGTPC} ${unidade}` : "❌"}`;

      await sock.sendMessage(remetente, { text: resposta });
      await registrarConsultaCSV(remetente, codigoProduto, 'SUCCESS', consulta.source);
    } else {
      const erroApi = consulta.data?.message || 'Produto não encontrado.';
      await sock.sendMessage(remetente, { 
        text: `❌ *NÃO ENCONTRADO*\n\nCódigo: ${codigoProduto}\nMotivo: ${erroApi}` 
      });
      await registrarConsultaCSV(remetente, codigoProduto, 'NOT_FOUND', consulta.source);
    }

  } catch (err) {
    logError('❌ Erro no comando:', err.message);
    await sock.sendMessage(remetente, { text: "❌ Erro interno. Tente novamente." });
  } finally {
    if (presenceSent) {
      try { await sock.sendPresenceUpdate('paused', remetente); } catch (err) {}
    }
  }
}

async function startBot() {
  if (isStarting) {
    logWarn('🔁 startBot já em progresso');
    return;
  }
  
  isStarting = true;
  logInfo('🚀 Iniciando bot WhatsApp...');

  try {
    let versionObj;
    try {
      versionObj = await fetchLatestBaileysVersion();
      logInfo('📦 Versão Baileys:', versionObj.version.join('.'));
    } catch (err) {
      logWarn('⚠️ Não foi possível obter versão, usando fallback');
      versionObj = { version: [2, 2412, 10] };
    }

    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_PATH);
    const sock = createWASocketCorporate(state, versionObj.version);
    globalSock = sock;
    reconnectAttempts = 0;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
          logInfo('📲 QR Code gerado - Escaneie:');
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
          logInfo('✅ CONECTADO ao WhatsApp!');
          reconnectAttempts = 0;
          
          if (presenceInterval) clearInterval(presenceInterval);
          presenceInterval = setInterval(async () => {
            try {
              if (globalSock?.user) {
                await globalSock.sendPresenceUpdate('available');
              }
            } catch (err) {
              logWarn('⚠️ Falha na presença:', err.message);
            }
          }, CONFIG.PRESENCE_INTERVAL);
        }

        if (connection === 'close') {
          let reason = 0;
          try {
            if (lastDisconnect?.error) {
              if (lastDisconnect.error.output?.statusCode) {
                reason = lastDisconnect.error.output.statusCode;
              } else if (isBoom(lastDisconnect.error)) {
                reason = lastDisconnect.error.output?.statusCode;
              } else {
                const boomified = boomify(lastDisconnect.error);
                reason = boomified.output?.statusCode || 0;
              }
            }
          } catch (e) {
            reason = 0;
          }

          const errorMsg = lastDisconnect?.error?.message || 'Desconhecido';
          logWarn('🔌 Conexão fechada:', `Código ${reason}`, `Motivo: ${errorMsg}`);

          if (reason === DisconnectReason.loggedOut) {
            logWarn('🔄 Sessão expirada - Gerando novo QR...');
            await deleteAuthInfoWithBackup();
            await safeStopSock();
            setTimeout(() => startBot(), 3000);
            return;
          }

          reconnectAttempts++;
          const delay = getBackoffDelay(reconnectAttempts);
          logWarn(`🔄 Reconexão #${reconnectAttempts} em ${delay}ms`);
          await safeStopSock();
          setTimeout(() => startBot(), delay);
        }
      } catch (err) {
        logError('❌ Erro no connection.update:', err.message);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      
      for (const currentMsg of messages) {
        if (!currentMsg?.message) continue;

        const messageTypes = {
          conversation: currentMsg.message.conversation,
          extendedTextMessage: currentMsg.message.extendedTextMessage?.text,
          imageMessage: currentMsg.message.imageMessage?.caption,
          videoMessage: currentMsg.message.videoMessage?.caption,
          documentMessage: currentMsg.message.documentMessage?.caption
        };

        const text = Object.values(messageTypes).find(t => t) || "";
        const userMessage = String(text).trim();
        
        if (!userMessage.startsWith('!')) continue;

        const remetente = currentMsg.key.remoteJid;
        handleBotCommands(sock, remetente, userMessage).catch(err => {
          logError('❌ Erro no handler:', err.message);
        });
      }
    });

    process.on('unhandledRejection', (reason) => {
      logError('🚨 Promise rejeitada:', reason);
    });

    process.on('uncaughtException', (error) => {
      logError('🚨 Exceção não tratada:', error);
    });

    isStarting = false;
    logInfo('✅ Bot WhatsApp inicializado');
    return sock;

  } catch (err) {
    isStarting = false;
    reconnectAttempts++;
    const delay = getBackoffDelay(reconnectAttempts);
    
    logError('❌ Falha ao iniciar bot:', err.message);
    await safeStopSock();
    setTimeout(() => startBot(), delay);
  }
}

// -----------------------------
// INICIALIZAÇÃO
// -----------------------------
(async () => {
  try {
    logInfo('🔧 Inicializando sistema...');
    
    if (CONFIG.ADMIN_NUMBERS.length > 0) {
      logInfo(`👑 Administradores: ${CONFIG.ADMIN_NUMBERS.length}`);
    } else {
      logWarn('⚠️ Nenhum administrador configurado');
    }
    
    await loadPersistedCache();
    await ensureCSV();
    startCacheMaintenance();
    await startBot();
    
    logInfo('🎉 Sistema inicializado e operacional');
    
  } catch (err) {
    logError('💥 Erro fatal:', err.message);
    process.exit(1);
  }
})();

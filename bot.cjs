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
  MAX_RETRIES: 15,
  RECONNECT_BASE_DELAY: 7000,
  PRESENCE_INTERVAL: 45000,
  API_TIMEOUT: 25000,
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
  
  // Configurações de rede corporativa
  USE_PROXY: process.env.USE_PROXY === 'true',
  PROXY_CONFIG: process.env.PROXY_HOST ? {
    host: process.env.PROXY_HOST,
    port: process.env.PROXY_PORT || 8080,
    auth: process.env.PROXY_USER ? {
      username: process.env.PROXY_USER,
      password: process.env.PROXY_PASS
    } : undefined
  } : null,
  
  // Timeouts adaptativos
  CONNECT_TIMEOUT: 30000,
  KEEP_ALIVE_INTERVAL: 20000,
  
  // Configurações específicas WhatsApp
  WS_ORIGIN: 'https://web.whatsapp.com',
  USER_AGENT: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// Validar API Key
if (!CONFIG.API_KEY) {
  console.error('❌ API_KEY não configurada. Defina API_KEY no arquivo .env');
  process.exit(1);
}

// -----------------------------
// SISTEMA DE LOGGING AVANÇADO
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

// Logger para console com cores
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

function logDebug(...args) {
  if (process.env.LOG_LEVEL === 'debug') {
    logger.debug(...args);
    clog('debug', ...args);
  }
}

// -----------------------------
// SISTEMA DE ADMINISTRAÇÃO
// -----------------------------
function isAdmin(jid) {
  if (!CONFIG.ADMIN_NUMBERS.length) {
    logWarn('⚠️ Nenhum admin configurado! Configure ADMIN_NUMBERS no .env');
    return false;
  }
  
  const isAdmin = CONFIG.ADMIN_NUMBERS.includes(jid);
  logDebug(`👑 Verificação admin: ${jid} -> ${isAdmin ? 'SIM' : 'NÃO'}`);
  return isAdmin;
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
// SISTEMA DE CACHE OTIMIZADO
// -----------------------------
let cachePlanilhas = {
  PTPC: { dados: null, timestamp: 0, hash: null },
  GTPC: { dados: null, timestamp: 0, hash: null }
};

let productCache = new Map();
let statistics = {
  totalQueries: 0,
  successfulQueries: 0,
  failedQueries: 0,
  cacheHits: 0,
  apiCalls: 0
};

// Carregar cache persistido
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

// Persistir cache
async function persistCache() {
  try {
    await fsp.writeFile(CONFIG.CACHE_PERSIST_FILE, JSON.stringify(cachePlanilhas), 'utf8');
    logDebug('💾 Cache de planilhas persistido no disco');
  } catch (err) {
    logWarn('⚠️ Falha ao persistir cache:', err.message);
  }
}

// Manutenção do cache
function startCacheMaintenance() {
  setInterval(() => {
    const now = Date.now();
    let cleaned = false;

    // Limpar cache de planilhas expirado
    for (const k of ['PTPC', 'GTPC']) {
      if (cachePlanilhas[k].timestamp && (now - cachePlanilhas[k].timestamp > CONFIG.CACHE_TTL_MS)) {
        cachePlanilhas[k] = { dados: null, timestamp: 0, hash: null };
        logInfo(`🧹 Cache da planilha ${k} expirou e foi limpo`);
        cleaned = true;
      }
    }

    // Limpar productCache expirado
    for (const [key, val] of productCache.entries()) {
      if (now - val.ts > CONFIG.PRODUCT_CACHE_TTL_MS) {
        productCache.delete(key);
        cleaned = true;
      }
    }

    if (cleaned) {
      persistCache().catch(e => logWarn('Erro ao persistir cache:', e.message));
    }
  }, 30 * 60 * 1000); // A cada 30 minutos
}

// -----------------------------
// SISTEMA DE REDE CORPORATIVA
// -----------------------------
async function createNetworkAgent() {
  try {
    // Se proxy está configurado e habilitado
    if (CONFIG.USE_PROXY && CONFIG.PROXY_CONFIG) {
      logInfo('🔌 Usando proxy corporativo:', CONFIG.PROXY_CONFIG.host);
      return new HttpsProxyAgent(CONFIG.PROXY_CONFIG);
    }

    // Agent direto com configurações para rede corporativa
    logDebug('🌐 Usando conexão direta (configuração corporativa)');
    return new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      timeout: CONFIG.API_TIMEOUT,
      maxFreeSockets: 10,
      keepAliveMsecs: 10000,
      // Configurações para contornar firewalls restritivos
      secureOptions: require('constants').SSL_OP_LEGACY_SERVER_CONNECT,
      checkServerIdentity: (host, cert) => {
        // Aceitar certificados com nomes diferentes (útil para proxies corporativos)
        return undefined;
      }
    });
  } catch (err) {
    logWarn('⚠️ Falha ao criar agent de rede, usando fallback:', err.message);
    return new https.Agent({ rejectUnauthorized: false });
  }
}

// -----------------------------
// DIAGNÓSTICO DE REDE
// -----------------------------
async function testNetworkConnectivity() {
  logInfo('🔍 Iniciando diagnóstico de rede...');
  
  const testUrls = [
    { name: 'Google', url: 'https://google.com' },
    { name: 'UTE Pecém', url: 'https://utepecem.com' },
    { name: 'WhatsApp Web', url: 'https://web.whatsapp.com' }
  ];

  const results = [];
  
  for (const test of testUrls) {
    try {
      const agent = await createNetworkAgent();
      const start = Date.now();
      
      const response = await axios.get(test.url, {
        httpsAgent: agent,
        timeout: 10000,
        validateStatus: () => true // Aceitar qualquer status
      });
      
      const duration = Date.now() - start;
      results.push(`✅ ${test.name}: ${response.status} (${duration}ms)`);
      logInfo(`✅ ${test.name}: ${response.status} (${duration}ms)`);
    } catch (err) {
      results.push(`❌ ${test.name}: ${err.message}`);
      logWarn(`❌ ${test.name}: ${err.message}`);
    }
  }
  
  return results.join('\n');
}

// -----------------------------
// BACKUP E GERENCIAMENTO DE AUTH
// -----------------------------
async function backupAuthInfo() {
  try {
    if (!fs.existsSync(CONFIG.AUTH_PATH)) return;
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(__dirname, 'backup');
    const dest = path.join(backupDir, `auth_info_backup_${timestamp}`);
    
    await fsp.mkdir(backupDir, { recursive: true });
    await fsp.cp(CONFIG.AUTH_PATH, dest, { recursive: true });
    
    logInfo('📦 Backup auth_info criado em', dest);
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
// CARREGAMENTO DE PLANILHAS
// -----------------------------
async function carregarPlanilhaCache(empresa) {
  try {
    const now = Date.now();
    const cached = cachePlanilhas[empresa];
    
    // Verificar se cache é válido
    if (cached?.dados && cached.timestamp && (now - cached.timestamp < CONFIG.CACHE_TTL_MS)) {
      logDebug(`📊 Retornando ${empresa} do cache (${cached.dados.length} registros)`);
      return cached.dados;
    }

    // Determinar arquivo
    let filePath;
    if (empresa === 'PTPC') {
      filePath = path.join(__dirname, 'Estoque Segurança PPTM.xlsx');
    } else if (empresa === 'GTPC') {
      filePath = path.join(__dirname, 'Estoque de segurança - Energia Pecém.xlsx');
    } else {
      return [];
    }

    // Verificar se arquivo existe
    if (!fs.existsSync(filePath)) {
      logWarn('⚠️ Planilha não encontrada:', filePath);
      return cached?.dados || []; // Retornar cache antigo se disponível
    }

    // Carregar e processar planilha
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const dados = XLSX.utils.sheet_to_json(sheet);
    
    // Atualizar cache
    cachePlanilhas[empresa] = { 
      dados, 
      timestamp: now,
      hash: require('crypto').createHash('md5').update(JSON.stringify(dados)).digest('hex')
    };
    
    logInfo(`📊 Planilha ${empresa} carregada: ${dados.length} registros`);
    return dados;
  } catch (err) {
    logError('❌ Erro ao carregar planilha:', err.message);
    // Retornar cache antigo em caso de erro
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
// CONSULTA DE PRODUTOS COM RESILIÊNCIA
// -----------------------------
async function consultarProdutoAPI(codigoProduto) {
  statistics.totalQueries++;
  
  // Verificar cache primeiro
  const now = Date.now();
  const cached = productCache.get(codigoProduto);
  if (cached && (now - cached.ts < CONFIG.PRODUCT_CACHE_TTL_MS)) {
    statistics.cacheHits++;
    logDebug('📦 Produto do cache:', codigoProduto);
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
          'Accept': 'application/json',
          'Cache-Control': 'no-cache'
        }
      }
    );

    // Cachear resposta
    productCache.set(codigoProduto, { 
      data: response.data, 
      ts: Date.now() 
    });

    statistics.successfulQueries++;
    return { success: true, data: response.data, source: 'api' };
  } catch (err) {
    statistics.failedQueries++;
    
    logWarn('❌ Erro na consulta API:', err.code, err.message);
    
    // Fallback estratégico
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
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
      return { success: false, error: 'Erro de DNS/Domínio não resolvido' };
    }
    
    return { success: false, error: 'Erro de comunicação com o sistema' };
  }
}

// -----------------------------
// LOGGING DE CONSULTAS EM CSV
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
let lastBaileysVersion = null;
let presenceInterval = null;

// Controle de rate limiting global
const rateLimiter = new Map();

function getBackoffDelay(attempts) {
  const cap = 8;
  const mult = Math.min(attempts, cap);
  return CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, mult - 1);
}

async function safeStopSock() {
  try {
    if (!globalSock) return;
    
    // Limpar intervals
    if (presenceInterval) {
      clearInterval(presenceInterval);
      presenceInterval = null;
    }
    
    // Tentar logout graceful
    try { 
      await globalSock.logout().catch(() => {}); 
    } catch {}
    
    // Limpar event listeners
    try { 
      globalSock.ev.removeAllListeners(); 
    } catch {}
    
    // Fechar WebSocket
    try { 
      if (globalSock.ws && globalSock.ws.close) {
        globalSock.ws.close();
      }
    } catch {}
    
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
    logger: P({ level: process.env.LOG_LEVEL || 'warn' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
    
    // Configurações otimizadas para rede corporativa
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    linkPreviewImageThumbnailWidth: 192,
    
    // Timeouts aumentados para rede corporativa
    connectTimeoutMs: CONFIG.CONNECT_TIMEOUT,
    keepAliveIntervalMs: CONFIG.KEEP_ALIVE_INTERVAL,
    maxIdleTimeMs: 90000,
    
    // Configurações WebSocket para firewall corporativo
    wsOptions: {
      origin: CONFIG.WS_ORIGIN,
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
      },
      // Agent para WebSocket (se proxy estiver configurado)
      agent: CONFIG.USE_PROXY && CONFIG.PROXY_CONFIG ? 
        new HttpsProxyAgent(CONFIG.PROXY_CONFIG) : undefined
    },
    
    // Retry policies
    retryRequestDelayMs: 2000,
    maxRetryCount: 3,
    emitOwnEvents: true,
    defaultQueryTimeoutMs: 60000
  };

  return makeWASocket(socketOptions);
}

// -----------------------------
// HANDLER DE COMANDOS
// -----------------------------
async function handleBotCommands(sock, remetente, userMessage) {
  let presenceSent = false;
  
  try {
    logInfo('📨 Comando recebido:', userMessage, 'de', remetente);

    // Rate limiting aprimorado
    const now = Date.now();
    const userLimit = rateLimiter.get(remetente) || { count: 0, lastTime: 0, blocked: false };
    
    // Reset se passou mais de 1 segundo
    if (now - userLimit.lastTime > 1000) {
      userLimit.count = 0;
      userLimit.lastTime = now;
      userLimit.blocked = false;
    }
    
    userLimit.count++;
    rateLimiter.set(remetente, userLimit);
    
    if (userLimit.count > 8 || userLimit.blocked) {
      userLimit.blocked = true;
      await sock.sendMessage(remetente, { 
        text: "⏳ Muitas consultas rápidas! Aguarde 1 segundo entre as consultas." 
      });
      await registrarConsultaCSV(remetente, userMessage.slice(1), 'RATE_LIMIT');
      return;
    }

    // Indicar "digitando"
    await sock.sendPresenceUpdate('composing', remetente);
    presenceSent = true;

    // COMANDO: !ajuda / !help
    if (userMessage === '!ajuda' || userMessage === '!help') {
      const isUserAdmin = isAdmin(remetente);
      
      let ajuda = `📚 *COMANDOS DISPONÍVEIS*

!12345678 - Consulta produto por código (8 dígitos)
!ajuda - Mostra esta mensagem
!status - Status do bot e estatísticas
!meunumero - Mostra seu número no WhatsApp`;

      // Adicionar comandos admin se for administrador
      if (isUserAdmin) {
        ajuda += `

👑 *COMANDOS ADMIN:*
!admin - Suas informações de admin
!diagnostico - Diagnóstico de rede
!atualizarcache - Atualiza cache
!estatisticas - Estatísticas detalhadas
!logs - Últimas consultas
!reiniciar - Reinicia o bot`;
      }

      ajuda += `\n\n_Desenvolvido para UTE Pecém_`;
      
      await sock.sendMessage(remetente, { text: ajuda });
      return;
    }

    // COMANDO: !meunumero - Descobrir número do usuário
    if (userMessage === '!meunumero') {
      await sock.sendMessage(remetente, { 
        text: `📱 *SEU NÚMERO NO WHATSAPP:*\n\n${remetente}\n\nPara se tornar admin, adicione este número no .env como ADMIN_NUMBERS` 
      });
      return;
    }

    // COMANDO: !admin - Informações de admin
    if (userMessage === '!admin') {
      const isUserAdmin = isAdmin(remetente);
      const adminInfo = isUserAdmin ? 
        `👑 *VOCÊ É ADMINISTRADOR*\n\nSeu número: ${remetente}\n\nComandos admin disponíveis:\n• !diagnostico - Diagnóstico de rede\n• !atualizarcache - Atualiza cache\n• !estatisticas - Estatísticas detalhadas\n• !logs - Últimas consultas\n• !reiniciar - Reinicia o bot` :
        `❌ *ACESSO NEGADO*\n\nSeu número: ${remetente}\n\nVocê não está na lista de administradores.\n\nPara se tornar admin, peça para adicionarem seu número no arquivo de configuração.`;
      
      await sock.sendMessage(remetente, { text: adminInfo });
      return;
    }

    // COMANDO: !status - Status do bot
    if (userMessage === '!status') {
      const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
      const cacheStatusPTPC = cachePlanilhas.PTPC?.dados ? `✅ (${cachePlanilhas.PTPC.dados.length} itens)` : '❌';
      const cacheStatusGTPC = cachePlanilhas.GTPC?.dados ? `✅ (${cachePlanilhas.GTPC.dados.length} itens)` : '❌';
      const isUserAdmin = isAdmin(remetente);
      
      let status = `🤖 *STATUS DO BOT*

✅ Conectado: ${sock.user ? 'Sim' : 'Não'}
🔄 Tentativas de reconexão: ${reconnectAttempts}
📊 Consultas totais: ${statistics.totalQueries}
💾 Cache hits: ${statistics.cacheHits}
📡 API calls: ${statistics.apiCalls}
🧠 Memória: ${memoryUsage}MB
🏭 Cache PTPC: ${cacheStatusPTPC}
🏭 Cache GTPC: ${cacheStatusGTPC}
🔌 Proxy: ${CONFIG.USE_PROXY ? '✅' : '❌'}`;

      if (isUserAdmin) {
        const cacheHitRate = statistics.totalQueries > 0 ? 
          ((statistics.cacheHits / statistics.totalQueries) * 100).toFixed(1) : 0;
        status += `\n\n👑 *ESTATÍSTICAS ADMIN:*\nTaxa de acerto: ${cacheHitRate}%\nAdmin: ✅`;
      }

      await sock.sendMessage(remetente, { text: status });
      return;
    }

    // COMANDO: !diagnostico - Apenas admin
    if (userMessage === '!diagnostico') {
      if (!isAdmin(remetente)) {
        await sock.sendMessage(remetente, { 
          text: "❌ *ACESSO NEGADO*\n\nEste comando é restrito a administradores." 
        });
        return;
      }
      
      await registrarAcaoAdmin(remetente, 'DIAGNOSTICO', 'Executou diagnóstico de rede');
      const diagnosis = await testNetworkConnectivity();
      await sock.sendMessage(remetente, { 
        text: `🔍 *DIAGNÓSTICO DE REDE - ADMIN*\n\n${diagnosis}` 
      });
      return;
    }

    // COMANDO: !atualizarcache - Apenas admin
    if (userMessage === '!atualizarcache') {
      if (!isAdmin(remetente)) {
        await sock.sendMessage(remetente, { 
          text: "❌ *ACESSO NEGADO*\n\nEste comando é restrito a administradores." 
        });
        return;
      }
      
      const beforePTPC = cachePlanilhas.PTPC.dados?.length || 0;
      const beforeGTPC = cachePlanilhas.GTPC.dados?.length || 0;
      const beforeProducts = productCache.size;
      
      // Limpar caches
      cachePlanilhas.PTPC = { dados: null, timestamp: 0, hash: null };
      cachePlanilhas.GTPC = { dados: null, timestamp: 0, hash: null };
      productCache.clear();
      
      await registrarAcaoAdmin(remetente, 'ATUALIZAR_CACHE', 
        `PTPC:${beforePTPC}->0, GTPC:${beforeGTPC}->0, Produtos:${beforeProducts}->0`);
      
      await sock.sendMessage(remetente, { 
        text: `🔄 *CACHE ATUALIZADO - ADMIN*\n\nCache limpo com sucesso!\n\nAntes:\n• PTPC: ${beforePTPC} itens\n• GTPC: ${beforeGTPC} itens\n• Produtos: ${beforeProducts} itens\n\nPróximas consultas recarregarão os dados frescos.` 
      });
      
      return;
    }

    // COMANDO: !estatisticas - Estatísticas detalhadas (admin)
    if (userMessage === '!estatisticas') {
      if (!isAdmin(remetente)) {
        await sock.sendMessage(remetente, { 
          text: "❌ *ACESSO NEGADO*\n\nEste comando é restrito a administradores." 
        });
        return;
      }
      
      const memoryUsage = process.memoryUsage();
      const uptime = Math.floor(process.uptime());
      const cacheHitRate = statistics.totalQueries > 0 ? 
        ((statistics.cacheHits / statistics.totalQueries) * 100).toFixed(1) : 0;
      
      const stats = `📊 *ESTATÍSTICAS DETALHADAS - ADMIN*

🤖 *SISTEMA:*
Uptime: ${Math.floor(uptime / 60)}min ${uptime % 60}s
Memória: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB
Reconexões: ${reconnectAttempts}

📈 *CONSULTAS:*
Total: ${statistics.totalQueries}
Sucesso: ${statistics.successfulQueries}
Falhas: ${statistics.failedQueries}
Cache Hits: ${statistics.cacheHits}
Chamadas API: ${statistics.apiCalls}
Taxa Cache: ${cacheHitRate}%

💾 *CACHE:*
PTPC: ${cachePlanilhas.PTPC.dados?.length || 0} itens
GTPC: ${cachePlanilhas.GTPC.dados?.length || 0} itens
Produtos: ${productCache.size} itens

👥 *USUÁRIOS ATIVOS:*
Última hora: ${Array.from(rateLimiter.keys()).length} usuários`;

      await registrarAcaoAdmin(remetente, 'ESTATISTICAS', 'Visualizou estatísticas detalhadas');
      await sock.sendMessage(remetente, { text: stats });
      return;
    }

    // COMANDO: !reiniciar - Reinicia o bot (admin)
    if (userMessage === '!reiniciar') {
      if (!isAdmin(remetente)) {
        await sock.sendMessage(remetente, { 
          text: "❌ *ACESSO NEGADO*\n\nEste comando é restrito a administradores." 
        });
        return;
      }
      
      await sock.sendMessage(remetente, { 
        text: "🔄 *REINICIANDO BOT - ADMIN*\n\nO bot será reiniciado. Aguarde 30 segundos..." 
      });
      
      await registrarAcaoAdmin(remetente, 'REINICIAR', 'Solicitou reinicialização do bot');
      
      // Reiniciar após delay
      setTimeout(async () => {
        await safeStopSock();
        await startBot();
      }, 3000);
      
      return;
    }

    // COMANDO: !logs - Últimas consultas (admin)
    if (userMessage === '!logs') {
      if (!isAdmin(remetente)) {
        await sock.sendMessage(remetente, { 
          text: "❌ *ACESSO NEGADO*\n\nEste comando é restrito a administradores." 
        });
        return;
      }
      
      try {
        if (fs.existsSync(CONFIG.QUERY_CSV)) {
          const data = await fsp.readFile(CONFIG.QUERY_CSV, 'utf8');
          const lines = data.trim().split('\n').slice(-10); // Últimas 10 consultas
          
          const logEntries = lines.reverse().map(line => {
            const [data, hora, usuario, codigo, status, origem] = line.split(',');
            const emoji = status === 'SUCCESS' ? '✅' : status === 'NOT_FOUND' ? '❌' : '⚠️';
            return `${emoji} ${data} ${hora} - ${codigo} - ${status}`;
          }).join('\n');
          
          await sock.sendMessage(remetente, { 
            text: `📋 *ÚLTIMAS 10 CONSULTAS - ADMIN*\n\n${logEntries || 'Nenhuma consulta registrada'}` 
          });
        } else {
          await sock.sendMessage(remetente, { 
            text: "📋 *LOGS - ADMIN*\n\nArquivo de logs não encontrado." 
          });
        }
      } catch (err) {
        await sock.sendMessage(remetente, { 
          text: `❌ *ERRO NOS LOGS - ADMIN*\n\n${err.message}` 
        });
      }
      
      await registrarAcaoAdmin(remetente, 'LOGS', 'Visualizou logs de consultas');
      return;
    }

    // CONSULTA DE PRODUTO: !12345678
    const codigoProduto = userMessage.slice(1);
    if (!/^\d{8}$/.test(codigoProduto)) {
      await sock.sendMessage(remetente, { 
        text: "⚠️ *FORMATO INVÁLIDO!*\n\nUse: !12345678 (8 dígitos numéricos)\nExemplo: !00012345" 
      });
      await registrarConsultaCSV(remetente, codigoProduto, 'INVALID_FORMAT');
      return;
    }

    // Consultar produto
    const consulta = await consultarProdutoAPI(codigoProduto);
    
    if (!consulta.success) {
      await sock.sendMessage(remetente, { 
        text: `❌ *ERRO NA CONSULTA*\n\n${consulta.error}` 
      });
      await registrarConsultaCSV(remetente, codigoProduto, 'API_ERROR', consulta.source);
      return;
    }

    if (consulta.data.success && consulta.data.data) {
      const produto = consulta.data.data;
      const unidade = produto.unidade;
      
      // Processar estoques
      const estoques = { PTPC: 0, GTPC: 0 };
      produto.estoques.forEach(e => {
        const qtd = parseFloat(e.qAtual) || 0;
        if (e.empresa === 'PTPC') estoques.PTPC += qtd;
        if (e.empresa === 'GTPC') estoques.GTPC += qtd;
      });

      // Obter estoque de segurança
      const [estoqueSegPTPC, estoqueSegGTPC] = await Promise.all([
        obterEstoqueSeguranca(produto.id, 'PTPC'),
        obterEstoqueSeguranca(produto.id, 'GTPC')
      ]);

      // Construir resposta
      const cacheIndicator = consulta.source === 'cache' ? ' (🔄 Cache)' : 
                            consulta.source === 'cache_expired' ? ' (⚠️ Cache Expirado)' : '';
      
      const resposta = `📦 *Produto Encontrado!*${cacheIndicator}

📌 *Código:* ${produto.id}
📃 *Texto breve:* ${produto.texto_breve}
📝 *Descrição completa:* ${produto.texto_completo}

📍 *Estoque por Empresa:*
🏭 *PPTM:* ${estoques.PTPC > 0 ? `${estoques.PTPC} ${unidade}` : "❌"}
🏭 *EP:* ${estoques.GTPC > 0 ? `${estoques.GTPC} ${unidade}` : "❌"}

⚠️ *Estoque de Segurança:*
🏭 *PPTM:* ${estoqueSegPTPC > 0 ? `${estoqueSegPTPC} ${unidade}` : "❌"}
🏭 *EP:* ${estoqueSegGTPC > 0 ? `${estoqueSegGTPC} ${unidade}` : "❌"}`;

      await sock.sendMessage(remetente, { text: resposta });
      await registrarConsultaCSV(remetente, codigoProduto, 'SUCCESS', consulta.source);
    } else {
      const erroApi = consulta.data?.message || 'Produto não encontrado no sistema.';
      await sock.sendMessage(remetente, { 
        text: `❌ *PRODUTO NÃO ENCONTRADO*\n\nCódigo: ${codigoProduto}\nMotivo: ${erroApi}` 
      });
      await registrarConsultaCSV(remetente, codigoProduto, 'NOT_FOUND', consulta.source);
    }

  } catch (err) {
    logError('❌ Erro no processamento do comando:', err.message);
    await sock.sendMessage(remetente, { 
      text: "❌ *ERRO INTERNO*\n\nOcorreu um erro inesperado. Tente novamente." 
    });
  } finally {
    // Parar indicador de "digitando"
    if (presenceSent) {
      try {
        await sock.sendPresenceUpdate('paused', remetente);
      } catch (err) {
        logDebug('⚠️ Erro ao pausar presença:', err.message);
      }
    }
  }
}

async function startBot() {
  if (isStarting) {
    logWarn('🔁 startBot já em progresso, ignorando chamada duplicada');
    return;
  }
  
  isStarting = true;
  logInfo('🚀 Iniciando bot WhatsApp...');

  try {
    // Obter versão do Baileys
    let versionObj;
    try {
      versionObj = await fetchLatestBaileysVersion();
      const verStr = versionObj.version.join('.');
      
      if (lastBaileysVersion && lastBaileysVersion !== verStr) {
        logWarn('🔔 Nova versão do Baileys:', verStr, '- Considere atualizar!');
      }
      lastBaileysVersion = verStr;
      logInfo('📦 Versão Baileys:', verStr);
    } catch (err) {
      logWarn('⚠️ Não foi possível obter versão do Baileys, usando fallback');
      versionObj = { version: [2, 2412, 10] };
    }

    // Estado de autenticação
    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_PATH);
    
    // Criar socket com configurações corporativas
    const sock = createWASocketCorporate(state, versionObj.version);
    globalSock = sock;
    reconnectAttempts = 0;

    // Gerenciar credenciais
    sock.ev.on('creds.update', saveCreds);

    // Handler de conexão
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
          logInfo('📲 QR Code para autenticação:');
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
          logInfo('✅ Bot conectado com sucesso ao WhatsApp!');
          reconnectAttempts = 0;
          
          // Iniciar heartbeat de presença
          if (presenceInterval) clearInterval(presenceInterval);
          presenceInterval = setInterval(async () => {
            try {
              if (globalSock?.user) {
                await globalSock.sendPresenceUpdate('available');
                logDebug('💓 Presença atualizada');
              }
            } catch (err) {
              logDebug('⚠️ Falha na presença:', err.message);
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
          logWarn('🔌 Conexão fechada. Código:', reason, 'Motivo:', errorMsg);

          // Logout detectado - reiniciar com novo QR
          if (reason === DisconnectReason.loggedOut) {
            logWarn('🔄 Sessão expirada. Reiniciando para novo QR...');
            await deleteAuthInfoWithBackup();
            await safeStopSock();
            setTimeout(() => startBot(), 3000);
            return;
          }

          // Reconexão com backoff
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

    // Handler de mensagens
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
        
        // Apenas comandos com !
        if (!userMessage.startsWith('!')) continue;

        const remetente = currentMsg.key.remoteJid;
        
        // Processar comando em background
        handleBotCommands(sock, remetente, userMessage).catch(err => {
          logError('❌ Erro no handler de comando:', err.message);
        });
      }
    });

    // Handlers globais de erro
    process.on('unhandledRejection', (reason, promise) => {
      logError('🚨 Promise rejeitada não tratada:', reason);
    });

    process.on('uncaughtException', (error) => {
      logError('🚨 Exceção não tratada:', error);
    });

    isStarting = false;
    logInfo('✅ Bot WhatsApp inicializado com sucesso');
    return sock;

  } catch (err) {
    isStarting = false;
    reconnectAttempts++;
    const delay = getBackoffDelay(reconnectAttempts);
    
    logError('❌ Falha crítica ao iniciar bot:', err.message);
    logError('🔧 Stack trace:', err.stack);
    
    await safeStopSock();
    setTimeout(() => startBot(), delay);
  }
}

// -----------------------------
// HEALTH CHECK SIMPLIFICADO
// -----------------------------
function startHealthCheck() {
  setInterval(() => {
    try {
      if (!globalSock || !globalSock.user) {
        logWarn('⚠️ Health Check: Socket não autenticado');
        return;
      }
      
      logDebug('💚 Health Check: Conexão saudável');
      
      // Log estatísticas periódicas
      const cacheHitRate = statistics.totalQueries > 0 ? 
        ((statistics.cacheHits / statistics.totalQueries) * 100).toFixed(1) : 0;
      
      logInfo(`📊 Estatísticas - Consultas: ${statistics.totalQueries}, Cache: ${statistics.cacheHits} (${cacheHitRate}%), API: ${statistics.apiCalls}`);
      
    } catch (e) {
      logWarn('⚠️ Health Check erro:', e.message);
    }
  }, 10 * 60 * 1000); // A cada 10 minutos
}

// -----------------------------
// INICIALIZAÇÃO
// -----------------------------
(async () => {
  try {
    logInfo('🔧 Inicializando sistema...');
    
    // Log de administradores configurados
    if (CONFIG.ADMIN_NUMBERS.length > 0) {
      logInfo(`👑 Administradores configurados: ${CONFIG.ADMIN_NUMBERS.length}`);
      CONFIG.ADMIN_NUMBERS.forEach((admin, index) => {
        logInfo(`  ${index + 1}. ${admin}`);
      });
    } else {
      logWarn('⚠️ Nenhum administrador configurado. Configure ADMIN_NUMBERS no .env');
    }
    
    // Inicializar componentes
    await loadPersistedCache();
    await ensureCSV();
    startCacheMaintenance();
    
    // Diagnóstico inicial de rede
    if (process.env.NETWORK_DIAGNOSIS !== 'false') {
      await testNetworkConnectivity();
    }
    
    // Iniciar bot
    await startBot();
    startHealthCheck();
    
    logInfo('🎉 Sistema totalmente inicializado e operacional');
    logInfo('🔌 Configuração de rede:', CONFIG.USE_PROXY ? 'Proxy corporativo' : 'Conexão direta');
    
  } catch (err) {
    logError('💥 Erro fatal na inicialização:', err.message);
    process.exit(1);
  }
})();
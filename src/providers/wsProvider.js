/**
 * Proveedor de precios via WebSocket — Matba-Rofex / Primary API
 *
 * Mantiene una conexión WebSocket permanente que recibe precios tick a tick.
 * El cache se actualiza en cuanto llega cada mensaje, sin polling.
 *
 * En Vercel (serverless) no funciona — el módulo devuelve null y el
 * llamador usa REST como fallback automáticamente.
 */

const WebSocket = require('ws');
const axios = require('axios');
const { getWatchList, getActiveSpotSymbol, pickLastOperated } = require('./dlrUtils');

const ENABLED = process.env.ENABLE_FUTURES === 'true';
const HTTP_BASE = process.env.FUTURES_BASE_URL || 'https://api.remarkets.primary.com.ar';
// WebSocket usa wss:// (seguro) cuando la base es https://
const WS_URL = HTTP_BASE.replace(/^https/, 'wss').replace(/^http(?!s)/, 'ws') + '/';
const USER = process.env.FUTURES_USER || '';
const PASS = process.env.FUTURES_PASSWORD || '';

// ── Cache de precios: { symbol → { lastPrice, bid, ask, updatedAt } }
const priceCache = new Map();

let ws           = null;
let wsReady      = false;
let reconnectTimer = null;
let watchdogTimer = null;
let lastMessageAt = 0;
let connectedAt = 0;

const WS_STALE_MS = Number(process.env.PRIMARY_WS_STALE_MS) || 90_000;
const WS_WATCHDOG_MS = 30_000;
const WS_MAX_SESSION_MS = Number(process.env.PRIMARY_WS_MAX_SESSION_MS) || 20 * 60_000;

// ── Obtener cookie de sesión (auth para WebSocket — Spring Security)
async function getCookie() {
  const body = `j_username=${encodeURIComponent(USER)}&j_password=${encodeURIComponent(PASS)}`;
  const res  = await axios.post(`${HTTP_BASE}/j_spring_security_check`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,        // capturar el 302 con la cookie antes de seguir
    validateStatus: s => s < 500,
    timeout: 8000,
  });
  const raw = res.headers['set-cookie'];
  if (!raw?.length) throw new Error('No se recibió cookie de sesión');
  return raw[0].split(';')[0]; // JSESSIONID=xxx
}

// ── Suscribir contratos al WebSocket
function subscribe(symbols) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const msg = {
    type:     'smd',
    level:    1,
    entries:  ['LA', 'SE', 'BI', 'OF'],
    products: symbols.map(s => ({ symbol: s, marketId: 'ROFX' })),
    depth:    1,
  };
  ws.send(JSON.stringify(msg));
}

// ── Conectar / reconectar
async function connect() {
  if (!ENABLED || !USER || !PASS) return; // sin credenciales → no conectar

  // Vercel serverless: process.env.VERCEL indica que estamos en Vercel
  // (los Workers tienen tiempo de vida corto, WebSocket no es viable)
  if (process.env.VERCEL) return;

  try {
    const cookie = await getCookie();
    const symbols = getWatchList();

    ws = new WebSocket(WS_URL, {
      headers: { Cookie: cookie },
      handshakeTimeout: 10000,
    });

    ws.on('open', () => {
      wsReady = true;
      connectedAt = Date.now();
      touchActivity();
      startWatchdog();
      subscribe(symbols);
      console.log(`[WS] Conectado a ${WS_URL} | Suscripto a: ${symbols.join(', ')}`);
    });

    ws.on('message', raw => {
      touchActivity();
      try {
        const msg = JSON.parse(raw);
        if (msg.type !== 'Md') return;

        const symbol = msg.instrumentId?.symbol;
        const md     = msg.marketData;
        if (!symbol || !md) return;

        const prev = priceCache.get(symbol);
        const lastPrice = pickLastOperated(md) ?? prev?.lastPrice ?? null;
        if (lastPrice == null && !md.BI && !md.OF) return;

        priceCache.set(symbol, {
          lastPrice,
          bid: md.BI?.[0]?.price ?? prev?.bid ?? null,
          ask: md.OF?.[0]?.price ?? prev?.ask ?? null,
          updatedAt: Date.now(),
        });
      } catch { /* ignorar mensajes no parseables */ }
    });

    ws.on('close', (code) => {
      wsReady = false;
      stopWatchdog();
      console.log(`[WS] Desconectado (${code}). Reconectando en 5s…`);
      scheduleReconnect(5000);
    });

    ws.on('error', err => {
      wsReady = false;
      stopWatchdog();
      console.warn(`[WS] Error: ${err.message}. Reconectando en 10s…`);
      scheduleReconnect(10000);
    });

  } catch (err) {
    console.warn(`[WS] Fallo al conectar: ${err.message}. Reconectando en 15s…`);
    scheduleReconnect(15000);
  }
}

function scheduleReconnect(ms) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(), ms);
}

function touchActivity() {
  lastMessageAt = Date.now();
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function startWatchdog() {
  stopWatchdog();
  watchdogTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const silent = lastMessageAt > 0 && now - lastMessageAt > WS_STALE_MS;
    const sessionOld = connectedAt > 0 && now - connectedAt > WS_MAX_SESSION_MS;
    if (silent || sessionOld) {
      console.warn('[WS] Watchdog: reconectando Primary…');
      forceReconnect();
    }
  }, WS_WATCHDOG_MS);
}

let lastForceReconnectAt = 0;

function forceReconnect() {
  const now = Date.now();
  if (now - lastForceReconnectAt < 45_000) return;
  lastForceReconnectAt = now;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopWatchdog();
  wsReady = false;
  connectedAt = 0;
  if (ws) {
    try {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    } catch { /* noop */ }
    ws = null;
  }
  scheduleReconnect(500);
}

// ── API pública

/**
 * ¿Está el WebSocket activo?
 */
function isConnected() { return wsReady; }

/**
 * Último (LA) del contrato DLR activo — mismo campo "Últ" que A3 futuros financieros.
 */
function getLatestSpot(maxAgeMs = 3 * 60_000) {
  const sym = getActiveSpotSymbol();
  const entry = priceCache.get(sym);
  if (!entry || Date.now() - entry.updatedAt > maxAgeMs) return null;
  if (entry.lastPrice == null) return null;
  return {
    symbol: sym,
    price: entry.lastPrice,
    bid: entry.bid ?? null,
    ask: entry.ask ?? null,
    fuente: 'Matba-Rofex WS',
  };
}

/**
 * Precio de un contrato específico desde el cache WS.
 */
function getCachedContract(symbol) {
  return priceCache.get(symbol) ?? null;
}

/**
 * Todos los precios cacheados.
 */
function getAllCached() {
  return Object.fromEntries(priceCache);
}

// Iniciar conexión al cargar el módulo
connect();

module.exports = {
  isConnected,
  getLatestSpot,
  getCachedContract,
  getAllCached,
  forceReconnect,
};

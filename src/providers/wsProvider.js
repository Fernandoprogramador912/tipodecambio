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
      subscribe(symbols);
      console.log(`[WS] Conectado a ${WS_URL} | Suscripto a: ${symbols.join(', ')}`);
    });

    ws.on('message', raw => {
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

    ws.on('close', (code, reason) => {
      wsReady = false;
      console.log(`[WS] Desconectado (${code}). Reconectando en 5s…`);
      scheduleReconnect(5000);
    });

    ws.on('error', err => {
      wsReady = false;
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

// ── API pública

/**
 * ¿Está el WebSocket activo?
 */
function isConnected() { return wsReady; }

/**
 * Último (LA) del contrato DLR activo — mismo campo "Últ" que A3 futuros financieros.
 */
function getLatestSpot() {
  const sym = getActiveSpotSymbol();
  const entry = priceCache.get(sym);
  if (!entry || Date.now() - entry.updatedAt > 60_000) return null;
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

module.exports = { isConnected, getLatestSpot, getCachedContract, getAllCached };

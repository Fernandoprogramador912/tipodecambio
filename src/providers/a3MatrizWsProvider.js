/**
 * Cotización "Últ" del encabezado Dólar USA en A3 (matbarofex.primary.ventures).
 * No es DLR/MAY26: es el instrumento DLR/SPOT (security id rx_DDF_DLR_SPOT).
 *
 * Protocolo Matriz DMA (mismo que la web):
 *   enviar: { _req:"S", topicType:"md", topics:["md.rx_DDF_DLR_SPOT"], replace:false }
 *   recibir: ["M:rx_DDF_DLR_SPOT|...|1397|2026-05-18T17:32:12Z|..."]
 */

const WebSocket = require('ws');
const axios = require('axios');

const WS_BASE = (process.env.A3_MATRIZ_WS_URL || 'wss://matbarofex.primary.ventures/ws')
  .replace(/\?.*$/, '');
const MD_TOPIC = process.env.A3_MD_TOPIC || 'md.rx_DDF_DLR_SPOT';
const ENABLED = process.env.ENABLE_FUTURES === 'true';

let cache = {
  price: null,
  bid: null,
  ask: null,
  asOf: null,
  closePrice: null,
  closeDate: null,
  topic: MD_TOPIC,
  updatedAt: 0,
};

let ws = null;
let reconnectTimer = null;
let connecting = false;

/** Campos en tick M: (pipe-separated). Índices verificados con A3 en vivo. */
const LST_FIELD_INDEX = 6;
const LSTD_FIELD_INDEX = 7;
const CLOSE_PRICE_INDEX = 15;
const CLOSE_DATE_INDEX = 16;

function parseMarketDataTick(line) {
  if (!line || !line.startsWith('M:')) return null;
  const parts = line.split('|');
  const topic = parts[0].slice(2);
  const price = parseFloat(parts[LST_FIELD_INDEX]);
  if (Number.isNaN(price)) return null;
  const asOf = parts[LSTD_FIELD_INDEX] || null;
  const closeRaw = parseFloat(parts[CLOSE_PRICE_INDEX]);
  const closePrice = Number.isNaN(closeRaw) ? null : closeRaw;
  const closeDate = parts[CLOSE_DATE_INDEX]?.trim() || null;
  return { topic, price, asOf, closePrice, closeDate };
}

function applyTick(tick) {
  const topicId = MD_TOPIC.replace(/^md\./, '');
  if (!tick || tick.topic !== topicId) return;

  cache = {
    price: tick.price,
    bid: cache.bid,
    ask: cache.ask,
    asOf: tick.asOf,
    closePrice: tick.closePrice ?? cache.closePrice,
    closeDate: tick.closeDate ?? cache.closeDate,
    topic: MD_TOPIC,
    updatedAt: Date.now(),
  };
}

function handleMessage(raw) {
  const text = raw.toString().trim();
  if (!text) return;

  const topicId = MD_TOPIC.replace(/^md\./, '');

  // Snapshot inicial: ["M:rx_DDF_DLR_SPOT|..."]
  if (text.startsWith('[')) {
    try {
      for (const line of JSON.parse(text)) {
        applyTick(parseMarketDataTick(line));
      }
    } catch { /* ignore */ }
    return;
  }

  // Actualizaciones en vivo: M:rx_DDF_DLR_SPOT|... (sin array)
  if (text.startsWith('M:')) {
    applyTick(parseMarketDataTick(text));
    return;
  }

  // A veces viene prefijado (ej. en reenvíos)
  const line = text.includes('M:') ? text.slice(text.indexOf('M:')) : null;
  if (line?.startsWith(`M:${topicId}`)) {
    applyTick(parseMarketDataTick(line.split('\n')[0]));
  }
}

function scheduleReconnect(ms = 5000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, ms);
}

async function connect() {
  if (!ENABLED || connecting) return;
  if (process.env.VERCEL) return;

  connecting = true;
  try {
    if (ws) {
      try { ws.close(); } catch { /* noop */ }
      ws = null;
    }

    const profile = await axios.get('https://matbarofex.primary.ventures/api/v2/profile', {
      timeout: 8000,
    });
    const csrf = profile.data?.csrfToken || '';
    const url = `${WS_BASE}?session_id=&conn_id=`;

    ws = new WebSocket(url, {
      headers: csrf ? { 'X-CSRF-TOKEN': csrf } : {},
      handshakeTimeout: 10000,
    });

    ws.on('open', () => {
      connecting = false;
      ws.send(JSON.stringify({
        _req: 'S',
        topicType: 'md',
        topics: [MD_TOPIC],
        replace: false,
      }));
      console.log(`[A3-WS] Suscrito a ${MD_TOPIC} (Últ Dólar USA en pantalla)`);
    });

    ws.on('message', handleMessage);

    ws.on('close', () => {
      connecting = false;
      scheduleReconnect(5000);
    });

    ws.on('error', () => {
      connecting = false;
      scheduleReconnect(10000);
    });
  } catch (err) {
    connecting = false;
    console.warn('[A3-WS] No se pudo conectar:', err.message);
    scheduleReconnect(15000);
  }
}

/**
 * Último de A3 (encabezado Dólar USA / DLR SPOT).
 */
function getDolarUsaUlt(maxAgeMs = 5 * 60_000) {
  const age = Date.now() - cache.updatedAt;
  const live = cache.price != null && cache.updatedAt > 0 && age <= maxAgeMs;
  const price = live ? cache.price : (cache.closePrice ?? cache.price);
  if (price == null) return null;

  return {
    symbol: 'DLR/SPOT',
    price,
    bid: cache.bid,
    ask: cache.ask,
    asOf: cache.asOf ? new Date(cache.asOf).toISOString() : new Date(cache.updatedAt).toISOString(),
    closePrice: cache.closePrice,
    closeDate: cache.closeDate,
    fuente: live ? 'A3 Matriz (DLR/SPOT)' : 'A3 Matriz (cierre)',
    _stale: !live,
  };
}

function isConnected() {
  return ws?.readyState === WebSocket.OPEN;
}

if (ENABLED) connect();

module.exports = { getDolarUsaUlt, isConnected, MD_TOPIC };

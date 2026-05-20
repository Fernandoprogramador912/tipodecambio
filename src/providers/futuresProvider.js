const axios = require('axios');
const wsProvider = require('./wsProvider');
const a3MatrizWs = require('./a3MatrizWsProvider');
const {
  MONTH_ABBR,
  nearestContracts,
  getMayoristaSymbol,
  getPinnedSpotSymbol,
  getActiveSpotSymbol,
  setActiveSpotSymbol,
  sortDlrContracts,
  pickLastOperated,
} = require('./dlrUtils');

const ENABLED = process.env.ENABLE_FUTURES === 'true';
const BASE_URL = process.env.FUTURES_BASE_URL || 'https://api.remarkets.primary.com.ar';
const FUTURES_USER = process.env.FUTURES_USER || '';
const FUTURES_PASSWORD = process.env.FUTURES_PASSWORD || '';

// LA=último operado; SE solo informativo en grilla, no para tarjeta USD
const MD_ENTRIES = 'LA,SE,BI,OF,OI';

const pickUltPrice = pickLastOperated;

// Cache de token: se renueva si vence
let authToken = null;
let tokenFetchedAt = 0;
const TOKEN_TTL_MS = 55 * 60 * 1000; // 55 minutos (tokens duran ~1h)

// Cache de futuros completo
let futuresCache = null;
let futuresCachedAt = 0;
const FUTURES_CACHE_TTL_MS = 15 * 1000; // 15 segundos

// Cache del spot de referencia (contrato más cercano, solo para USD card)
let spotRefCache = null;
let spotRefCachedAt = 0;
const SPOT_REF_TTL_MS = 3 * 1000; // reconsultar LA/trades cada pocos segundos
const TRADES_CACHE_TTL_MS = 3 * 1000;

let spotSymbolResolvedAt = 0;
/** @type {Map<string, { price: number, asOf: number, fetchedAt: number }>} */
const lastTradeCache = new Map();
const SPOT_SYMBOL_TTL_MS = 60 * 60 * 1000; // re-resolver contrato front mes cada 1h

/** Últ del encabezado "Dólar USA" en A3 → DLR/SPOT (no el futuro DLR/MAY26). */
async function resolveSpotSymbol() {
  const sym = getMayoristaSymbol();
  setActiveSpotSymbol(sym);
  return sym;
}

async function authenticate() {
  const now = Date.now();
  if (authToken && now - tokenFetchedAt < TOKEN_TTL_MS) {
    return authToken;
  }

  const res = await axios.post(
    `${BASE_URL}/auth/getToken`,
    null,
    {
      headers: {
        'X-Username': FUTURES_USER,
        'X-Password': FUTURES_PASSWORD,
        'Content-Type': 'application/json',
      },
      timeout: 8000,
    }
  );

  const token = res.headers['x-auth-token'];
  if (!token) throw new Error('No se recibió X-Auth-Token en la respuesta de autenticación');

  authToken = token;
  tokenFetchedAt = now;
  return token;
}

async function fetchContractData(token, symbol) {
  try {
    const res = await axios.get(`${BASE_URL}/rest/marketdata/get`, {
      params: {
        marketId: 'ROFX',
        symbol,
        entries: MD_ENTRIES,
      },
      headers: {
        'X-Auth-Token': token,
      },
      timeout: 6000,
    });

    if (res.data?.status !== 'OK') {
      return { symbol, lastPrice: null, bid: null, ask: null, error: 'Contrato no disponible' };
    }

    const md = res.data.marketData;

    // LA es un objeto directo, BI/OF son arrays de niveles de profundidad
    const last = pickUltPrice(md);
    const bid  = Array.isArray(md.BI) && md.BI.length > 0 ? md.BI[0].price : null;
    const ask  = Array.isArray(md.OF) && md.OF.length > 0 ? md.OF[0].price : null;
    const oi   = md.OI?.size ?? null;

    return { symbol, lastPrice: last, bid, ask, openInterest: oi };
  } catch {
    return { symbol, lastPrice: null, bid: null, ask: null, error: 'Sin cotización' };
  }
}

async function fetchAvailableContracts(token) {
  try {
    const res = await axios.get(`${BASE_URL}/rest/instruments/all`, {
      headers: { 'X-Auth-Token': token },
      timeout: 8000,
    });
    const all = res.data?.instruments || [];
    // Solo futuros DLR simples ordenados por vencimiento implícito
    const dlr = sortDlrContracts(
      all
        .filter(i => /^DLR\/[A-Z]{3}\d{2}$/.test(i.instrumentId?.symbol))
        .map(i => i.instrumentId.symbol)
    );
    return dlr.length > 0 ? dlr.slice(0, 8) : nearestContracts(6);
  } catch {
    return nearestContracts(6);
  }
}

async function fetchAllFutures() {
  const token = await authenticate();
  const contracts = await fetchAvailableContracts(token);

  const results = await Promise.all(
    contracts.map(s => fetchContractData(token, s))
  );

  return results;
}

async function getFutures() {
  if (!ENABLED) {
    return {
      enabled: false,
      contracts: nearestContracts(6).map(symbol => ({
        symbol, lastPrice: null, bid: null, ask: null,
        note: 'Activar con ENABLE_FUTURES=true en .env',
        stub: true,
      })),
    };
  }

  const now = Date.now();
  if (futuresCache && now - futuresCachedAt < FUTURES_CACHE_TTL_MS) {
    return { enabled: true, contracts: futuresCache, cached: true };
  }

  const contracts = await fetchAllFutures();

  // Enriquecer con datos WS si están disponibles (más frescos que REST)
  const enriched = contracts.map(c => {
    const ws = wsProvider.getCachedContract(c.symbol);
    if (!ws) return c;
    const wsAge = Date.now() - (ws.updatedAt ?? 0);
    if (wsAge > 60_000) return c; // ignorar si tiene más de 60s
    return {
      ...c,
      lastPrice:    ws.lastPrice ?? c.lastPrice,
      bid:          ws.bid       ?? c.bid,
      ask:          ws.ask       ?? c.ask,
    };
  });

  futuresCache    = enriched;
  futuresCachedAt = now;
  return { enabled: true, contracts: enriched, cached: false };
}

/**
 * Últ del encabezado Dólar USA en A3 (DLR/SPOT vía WebSocket Matriz).
 * Primary REST solo complementa bid/ask si hay sesión.
 */
function mapSpotRef(live) {
  return {
    symbol: live.symbol,
    price: live.price,
    bid: live.bid,
    ask: live.ask,
    asOf: live.asOf,
    closePrice: live.closePrice,
    closeDate: live.closeDate,
    fuente: live.fuente,
    _stale: live._stale,
    _fromClose: live._fromClose,
  };
}

async function fetchRestSpotRef() {
  const token = await authenticate();
  const sym = await resolveSpotSymbol();
  const data = await fetchContractData(token, sym);

  if (data.lastPrice == null && data.bid == null && data.ask == null) {
    return spotRefCache?.symbol === sym ? mapSpotRef(spotRefCache) : null;
  }

  const result = {
    symbol: sym,
    price: data.lastPrice,
    bid: data.bid ?? null,
    ask: data.ask ?? null,
    asOf: new Date().toISOString(),
    fuente: 'Matba-Rofex',
    _stale: false,
    _fromClose: false,
  };
  if (result.price != null) {
    spotRefCache = result;
    spotRefCachedAt = Date.now();
  }
  return result.price != null ? result : (spotRefCache ? mapSpotRef(spotRefCache) : null);
}

async function getSpotRef() {
  if (!ENABLED) return null;

  const a3 = a3MatrizWs.getDolarUsaUlt();
  if (a3?._stale) {
    a3MatrizWs.forceReconnect();
  }

  if (a3?.price != null && !a3._stale) {
    spotRefCache = a3;
    spotRefCachedAt = Date.now();
    return mapSpotRef(a3);
  }

  try {
    const wsSpot = wsProvider.getLatestSpot();
    if (wsSpot?.price != null) {
      const result = {
        symbol: wsSpot.symbol,
        price: wsSpot.price,
        bid: wsSpot.bid,
        ask: wsSpot.ask,
        asOf: new Date().toISOString(),
        fuente: wsSpot.fuente,
        closePrice: a3?.closePrice,
        closeDate: a3?.closeDate,
        _stale: false,
        _fromClose: false,
      };
      spotRefCache = result;
      spotRefCachedAt = Date.now();
      return result;
    }

    const rest = await fetchRestSpotRef();
    if (rest?.price != null) return rest;
  } catch (err) {
    console.warn('[getSpotRef]', err.message);
  }

  if (a3?.price != null) {
    return mapSpotRef(a3);
  }

  return spotRefCache ? mapSpotRef(spotRefCache) : null;
}

module.exports = { getFutures, getSpotRef, ENABLED };

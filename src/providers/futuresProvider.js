const axios    = require('axios');
const wsProvider = require('./wsProvider');

const ENABLED = process.env.ENABLE_FUTURES === 'true';
const BASE_URL = process.env.FUTURES_BASE_URL || 'https://api.remarkets.primary.com.ar';
const FUTURES_USER = process.env.FUTURES_USER || '';
const FUTURES_PASSWORD = process.env.FUTURES_PASSWORD || '';

// Meses en español para construir los símbolos DLR/MMMYY
const MONTH_ABBR = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];

// Entradas de market data: LA=último, BI=bid, OF=offer, OI=interés abierto
const MD_ENTRIES = 'LA,BI,OF,OI';

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
const SPOT_REF_TTL_MS = 8 * 1000; // 8s — mismo ritmo que /api/fx

function getUpcomingContracts(count = 6) {
  const contracts = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const abbr = MONTH_ABBR[d.getMonth()];
    const yy = String(d.getFullYear()).slice(-2);
    contracts.push(`DLR/${abbr}${yy}`);
  }
  return contracts;
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
    const last = md.LA?.price ?? null;
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
    const dlr = all
      .filter(i => /^DLR\/[A-Z]{3}\d{2}$/.test(i.instrumentId?.symbol))
      .map(i => i.instrumentId.symbol)
      .sort();
    return dlr.length > 0 ? dlr.slice(0, 8) : getUpcomingContracts(6);
  } catch {
    return getUpcomingContracts(6);
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
      contracts: getUpcomingContracts(6).map(symbol => ({
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
 * Devuelve el precio del contrato DLR más próximo.
 * Prioridad: WebSocket cache (tick a tick) → REST (polling cada 8s)
 */
async function getSpotRef() {
  if (!ENABLED) return null;

  // 1. Intentar WebSocket cache (dato en tiempo real)
  const wsSpot = wsProvider.getLatestSpot();
  if (wsSpot) return wsSpot;

  // 2. Fallback REST con cache
  const now = Date.now();
  if (spotRefCache && now - spotRefCachedAt < SPOT_REF_TTL_MS) {
    return spotRefCache;
  }

  try {
    const token = await authenticate();

    const d = new Date();
    for (let i = 0; i < 3; i++) {
      const ref  = new Date(d.getFullYear(), d.getMonth() + i, 1);
      const sym  = `DLR/${MONTH_ABBR[ref.getMonth()]}${String(ref.getFullYear()).slice(-2)}`;
      const data = await fetchContractData(token, sym);
      const price = data.lastPrice ?? data.bid ?? data.ask;
      if (price) {
        const result = {
          symbol: sym,
          price,
          bid:    data.bid  ?? null,
          ask:    data.ask  ?? null,
          fuente: 'Matba-Rofex',
        };
        spotRefCache    = result;
        spotRefCachedAt = now;
        return result;
      }
    }
    return null;
  } catch {
    return spotRefCache ?? null;
  }
}

module.exports = { getFutures, getSpotRef, ENABLED };

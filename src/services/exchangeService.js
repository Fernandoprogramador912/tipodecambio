const axios = require('axios');
const { record } = require('./historyService');
const { getForexVsUsd } = require('./forexService');
const { getSpotRef, ENABLED: FUTURES_ENABLED } = require('../providers/futuresProvider');
const cierreStore = require('./mayoristaCierreStore');
require('../config/mayoristaSource');

const DOLAR_API_BASE = 'https://dolarapi.com/v1';
const AMBITO_BASE = 'https://mercados.ambito.com';
const CACHE_TTL_MS = FUTURES_ENABLED ? 2000 : 5000;
const EUR_VENTA_ADJUST_ARS = Number(process.env.EUR_VENTA_ADJUST_ARS) || 2;

/** EUR/ARS venta = último TC mayorista (USD) × EUR/USD (FX internacional) + ajuste fijo. */
function buildEurVenta(usd, forexGlobal) {
  const mayoristaVenta = usd?.venta;
  const eurUsd = forexGlobal?.pairs?.find(p => p.pair === 'EUR/USD')?.rate;
  if (mayoristaVenta == null || eurUsd == null) return null;

  const venta = +(mayoristaVenta * eurUsd + EUR_VENTA_ADJUST_ARS).toFixed(2);
  return {
    nombre: 'Euro',
    venta,
    mayoristaUsd: mayoristaVenta,
    eurUsd,
    ajusteARS: EUR_VENTA_ADJUST_ARS,
    fechaActualizacion: forexGlobal?.fetchedAt || new Date().toISOString(),
    fuente: 'Mayorista × EUR/USD + $2',
  };
}

let cierreCache = { valor: null, fecha: null, fuente: null, fetchedAt: 0 };
const CIERRE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function parseAmbitoNum(str) {
  if (str == null) return null;
  const n = parseFloat(String(str).replace(/\./g, '').replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

let cache = {
  data: null,
  fetchedAt: 0,
};

function isChartSessionART() {
  const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const m = art.getUTCHours() * 60 + art.getUTCMinutes();
  return m >= 10 * 60 && m <= 15 * 60;
}

let lastExchangeRecordAt = 0;
const EXCHANGE_RECORD_THROTTLE_MS = 5 * 60 * 1000; // 5 min

function maybeRecord(venta, ts) {
  if (!isChartSessionART()) return;
  const now = Date.now();
  if (now - lastExchangeRecordAt < EXCHANGE_RECORD_THROTTLE_MS) return;
  lastExchangeRecordAt = now;
  record(venta, venta, ts || new Date().toISOString());
}

/** Último cierre de rueda anterior (día < hoy ART): A3 histórico o fallback Ámbito/DolarApi. */
async function fetchUltimoCierre(spot) {
  if (spot?.closePrice != null && spot?.closeDate) {
    cierreStore.recordClose(spot.closeDate, spot.closePrice);
  }

  const stored = cierreStore.getCierreAnterior();
  if (stored.cierreValor != null) {
    return {
      cierreValor: stored.cierreValor,
      cierreFecha: stored.cierreFecha,
      cierreFuente: 'A3',
    };
  }

  const now = Date.now();
  if (cierreCache.valor != null && now - cierreCache.fetchedAt < CIERRE_CACHE_TTL_MS) {
    const cacheDate = cierreCache.fecha;
    const today = cierreStore.todayART();
    if (cacheDate && cacheDate >= today) {
      return { cierreValor: null, cierreFecha: null, cierreFuente: cierreCache.fuente };
    }
    return {
      cierreValor: cierreCache.valor,
      cierreFecha: cierreCache.fecha,
      cierreFuente: cierreCache.fuente,
    };
  }

  try {
    const [ambitoRes, dolarRes] = await Promise.allSettled([
      axios.get(`${AMBITO_BASE}/dolar/mayorista/variacion`, { timeout: 5000 }),
      axios.get(`${DOLAR_API_BASE}/dolares/mayorista`, { timeout: 5000 }),
    ]);

    if (ambitoRes.status === 'fulfilled') {
      const ant = parseAmbitoNum(ambitoRes.value.data?.valor_cierre_ant);
      if (ant != null) {
        const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
        art.setUTCDate(art.getUTCDate() - 1);
        const ayer = art.toISOString().slice(0, 10);
        cierreStore.recordClose(ayer, ant);
        cierreCache = { valor: ant, fecha: ayer, fuente: 'Ámbito', fetchedAt: now };
        return { cierreValor: ant, cierreFecha: ayer, cierreFuente: 'Ámbito' };
      }
    }

    if (dolarRes.status === 'fulfilled') {
      const d = dolarRes.value.data;
      const fecha = d.fechaActualizacion ? d.fechaActualizacion.slice(0, 10) : null;
      const today = cierreStore.todayART();
      if (d.venta != null && fecha && fecha < today) {
        cierreStore.recordClose(fecha, d.venta);
        cierreCache = { valor: d.venta, fecha, fuente: 'DolarApi', fetchedAt: now };
        return { cierreValor: d.venta, cierreFecha: fecha, cierreFuente: 'DolarApi' };
      }
    }
  } catch { /* sin cierre auxiliar */ }

  return { cierreValor: null, cierreFecha: null, cierreFuente: null };
}

/** Dólar mayorista en UI = Últ A3 en rueda; fuera de rueda → último cierre (A3/Ámbito/DolarApi). */
async function fetchMayoristaFromA3() {
  const spot = await getSpotRef();
  const cierre = await fetchUltimoCierre(spot);
  const venta = spot?.price ?? cierre.cierreValor ?? null;

  if (venta == null) {
    throw new Error('Sin cotización mayorista (A3 ni cierre auxiliar disponible)');
  }

  const fromLive = spot?.price != null && !spot?._stale && !spot?._fromClose;
  const fromLastTick = spot?.price != null && spot?._stale && !spot?._fromClose;

  return {
    nombre: 'Mayorista',
    venta,
    fechaActualizacion: spot?.asOf ?? new Date().toISOString(),
    fuente: fromLive
      ? (spot.fuente || 'A3')
      : fromLastTick
        ? (spot.fuente || 'A3')
        : (cierre.cierreFuente || spot?.fuente || 'Cierre'),
    cierreValor: cierre.cierreValor ?? null,
    cierreFecha: cierre.cierreFecha ?? null,
    cierreFuente: cierre.cierreFuente,
    _fromA3: fromLive || fromLastTick,
    _fromCierre: !fromLive && !fromLastTick,
    _stale: Boolean(spot?._stale && !fromLive),
  };
}

async function fetchMayorista() {
  if (!FUTURES_ENABLED) {
    throw new Error('ENABLE_FUTURES=true requerido para cotización mayorista desde A3');
  }
  if (!process.env.FUTURES_USER || !process.env.FUTURES_PASSWORD) {
    throw new Error('FUTURES_USER y FUTURES_PASSWORD requeridos');
  }

  try {
    return await fetchMayoristaFromA3();
  } catch (err) {
    if (cache.data?.usd?._fromA3) {
      console.warn('[USD] A3 temporalmente sin dato nuevo:', err.message);
      return { ...cache.data.usd, _stale: true };
    }
    throw err;
  }
}

async function fetchRates() {
  const [usd, mep, forexGlobal] = await Promise.all([
    fetchMayorista(),
    axios.get(`${DOLAR_API_BASE}/dolares/bolsa`, { timeout: 5000 }).then(r => r.data).catch(() => null),
    getForexVsUsd().catch(() => null),
  ]);

  const mepCompra = mep?.compra ?? null;
  const mayoristaVenta = usd.venta ?? null;
  const spreadMonto = mepCompra && mayoristaVenta ? +(mepCompra - mayoristaVenta).toFixed(2) : null;
  const spreadPct = spreadMonto != null && mayoristaVenta
    ? +(spreadMonto / mayoristaVenta * 100).toFixed(2)
    : null;

  return {
    usd,
    eur: buildEurVenta(usd, forexGlobal),
    mep: mep ? {
      nombre: 'MEP (Bolsa)',
      compra: mep.compra,
      venta: mep.venta,
      fechaActualizacion: mep.fechaActualizacion,
      fuente: 'DolarApi.com',
    } : null,
    spreadMepMayorista: { montoARS: spreadMonto, pct: spreadPct },
    forexGlobal,
  };
}

async function getRates() {
  const now = Date.now();

  // USD siempre desde A3 en vivo (WebSocket); no reutilizar caché de hace N segundos
  let usd;
  try {
    usd = await fetchMayorista();
  } catch (err) {
    if (cache.data?.usd?._fromA3) {
      usd = { ...cache.data.usd, _stale: true };
    } else {
      throw err;
    }
  }

  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    const { usd: _u, ...rest } = cache.data;
    const eur = buildEurVenta(usd, rest.forexGlobal);
    const merged = { ...rest, usd, eur, cached: true };
    if (usd?.venta) maybeRecord(usd.venta, usd.fechaActualizacion);
    return merged;
  }

  try {
    const [mep, forexGlobal] = await Promise.all([
      axios.get(`${DOLAR_API_BASE}/dolares/bolsa`, { timeout: 5000 }).then(r => r.data).catch(() => null),
      getForexVsUsd().catch(err => {
        console.warn('[forexGlobal]', err.message);
        return cache.data?.forexGlobal ?? null;
      }),
    ]);

    const mepCompra = mep?.compra ?? null;
    const mayoristaVenta = usd.venta ?? null;
    const spreadMonto = mepCompra && mayoristaVenta ? +(mepCompra - mayoristaVenta).toFixed(2) : null;
    const spreadPct = spreadMonto != null && mayoristaVenta
      ? +(spreadMonto / mayoristaVenta * 100).toFixed(2)
      : null;

    const rates = {
      usd,
      eur: buildEurVenta(usd, forexGlobal),
      mep: mep ? {
        nombre: 'MEP (Bolsa)',
        compra: mep.compra,
        venta: mep.venta,
        fechaActualizacion: mep.fechaActualizacion,
        fuente: 'DolarApi.com',
      } : null,
      spreadMepMayorista: { montoARS: spreadMonto, pct: spreadPct },
      forexGlobal,
    };

    cache = { data: rates, fetchedAt: now };

    if (usd?.venta) maybeRecord(usd.venta, usd.fechaActualizacion);

    return { ...rates, cached: false };
  } catch (err) {
    if (cache.data) {
      return { ...cache.data, usd, cached: true, stale: true, error: err.message };
    }
    throw err;
  }
}

module.exports = { getRates };

const axios = require('axios');

/** Tipos de cambio vs USD (Frankfurter / BCE). Sin API key. */
const FRANKFURTER_BASE = 'https://api.frankfurter.app';
const CACHE_TTL_MS = 10 * 60 * 1000;

const CURRENCIES = ['EUR', 'BRL', 'GBP', 'JPY', 'CHF', 'CNY', 'MXN'];

const PAIR_DEFS = [
  { pair: 'EUR/USD', flags: ['eu', 'us'], left: 'Euro', right: 'USD', currency: 'EUR', kind: 'usdPerUnit' },
  { pair: 'USD/BRL', flags: ['us', 'br'], left: 'USD', right: 'Real', currency: 'BRL', kind: 'unitsPerUsd' },
  { pair: 'GBP/USD', flags: ['gb', 'us'], left: 'Libra', right: 'USD', currency: 'GBP', kind: 'usdPerUnit' },
  { pair: 'USD/JPY', flags: ['us', 'jp'], left: 'USD', right: 'Yen', currency: 'JPY', kind: 'unitsPerUsd' },
  { pair: 'USD/CNY', flags: ['us', 'cn'], left: 'USD', right: 'Yuan', currency: 'CNY', kind: 'unitsPerUsd' },
  { pair: 'USD/CHF', flags: ['us', 'ch'], left: 'USD', right: 'Franco', currency: 'CHF', kind: 'unitsPerUsd' },
  { pair: 'USD/MXN', flags: ['us', 'mx'], left: 'USD', right: 'Peso MX', currency: 'MXN', kind: 'unitsPerUsd' },
];

let cache = { data: null, fetchedAt: 0 };

function roundRate(value, decimals) {
  if (value == null || Number.isNaN(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function pairDecimals(def) {
  return def.kind === 'unitsPerUsd' && def.currency === 'JPY' ? 2 : 4;
}

/** Convierte cotización Frankfurter (unidades de `currency` por 1 USD) al par mostrado. */
function rateFromUsdQuote(def, usdRates) {
  const raw = usdRates?.[def.currency];
  if (raw == null || raw <= 0) return null;
  return def.kind === 'usdPerUnit' ? 1 / raw : raw;
}

/**
 * Movimiento de la moneda extranjera vs USD respecto al cierre anterior.
 * usdPerUnit: sube el par → la moneda se aprecia vs USD.
 * unitsPerUsd: sube el par → la moneda se deprecia vs USD (más unidades por dólar).
 */
function foreignVsUsdMove(def, rateNow, ratePrev) {
  if (rateNow == null || ratePrev == null || ratePrev === 0) {
    return { changePct: null, vsUsd: null, changeAbs: null };
  }

  const changeAbs = rateNow - ratePrev;
  const changePct = (changeAbs / ratePrev) * 100;
  const flat = Math.abs(changePct) < 0.005;

  let vsUsd = 'estable';
  if (!flat) {
    const foreignAppreciated = def.kind === 'usdPerUnit' ? changeAbs > 0 : changeAbs < 0;
    vsUsd = foreignAppreciated ? 'aprecia' : 'deprecia';
  }

  return {
    changeAbs: roundRate(changeAbs, pairDecimals(def)),
    changePct: roundRate(changePct, 2),
    vsUsd,
  };
}

function buildPair(def, usdRates, prevUsdRates, cierreFecha) {
  const rate = rateFromUsdQuote(def, usdRates);
  if (rate == null) return null;

  const decimals = pairDecimals(def);
  const rateRounded = roundRate(rate, decimals);
  const ratePrev = prevUsdRates ? rateFromUsdQuote(def, prevUsdRates) : null;
  const move = foreignVsUsdMove(def, rateRounded, ratePrev != null ? roundRate(ratePrev, decimals) : null);

  const foreignName = def.kind === 'usdPerUnit' ? def.left : def.right;

  return {
    pair: def.pair,
    flags: def.flags,
    left: def.left,
    right: def.right,
    foreignName,
    rate: rateRounded,
    ratePrev: ratePrev != null ? roundRate(ratePrev, decimals) : null,
    cierreFecha: ratePrev != null ? cierreFecha : null,
    changePct: move.changePct,
    changeAbs: move.changeAbs,
    vsUsd: move.vsUsd,
    decimals,
    subtitle: def.kind === 'usdPerUnit' ? 'USD por 1 unidad' : 'Unidades por 1 USD',
  };
}

async function fetchUsdRatesForDate(dateStr) {
  const res = await axios.get(`${FRANKFURTER_BASE}/${dateStr}`, {
    params: { from: 'USD', to: CURRENCIES.join(',') },
    timeout: 8000,
    headers: { 'User-Agent': 'DashboardTC/1.0' },
  });
  return { rates: res.data.rates, date: res.data.date };
}

/** Último cierre BCE publicado antes de `sessionDate`. */
async function fetchPreviousClose(sessionDate) {
  const cursor = new Date(`${sessionDate}T12:00:00Z`);

  for (let i = 0; i < 12; i++) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const tryDate = cursor.toISOString().slice(0, 10);
    try {
      return await fetchUsdRatesForDate(tryDate);
    } catch (err) {
      if (err.response?.status !== 404) throw err;
    }
  }
  return null;
}

async function fetchForexVsUsd() {
  const latestRes = await axios.get(`${FRANKFURTER_BASE}/latest`, {
    params: { from: 'USD', to: CURRENCIES.join(',') },
    timeout: 8000,
    headers: { 'User-Agent': 'DashboardTC/1.0' },
  });

  const { rates, date } = latestRes.data;
  const prev = await fetchPreviousClose(date);

  const pairs = PAIR_DEFS
    .map(def => buildPair(def, rates, prev?.rates, prev?.date))
    .filter(Boolean);

  return {
    base: 'USD',
    fecha: date,
    cierreReferencia: prev?.date ?? null,
    fuente: 'Frankfurter (BCE)',
    pairs,
  };
}

async function getForexVsUsd() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { ...cache.data, cached: true };
  }

  try {
    const data = await fetchForexVsUsd();
    cache = { data, fetchedAt: now };
    return { ...data, cached: false };
  } catch (err) {
    if (cache.data) {
      return { ...cache.data, cached: true, stale: true, error: err.message };
    }
    throw err;
  }
}

module.exports = { getForexVsUsd };

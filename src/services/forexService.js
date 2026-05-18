const axios = require('axios');

/** Tipos de cambio vs USD (Frankfurter / BCE). Sin API key, uso local con internet. */
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest';
const CACHE_TTL_MS = 10 * 60 * 1000;

const CURRENCIES = ['EUR', 'BRL', 'GBP', 'JPY', 'CHF', 'CNY', 'MXN'];

/**
 * Pares mostrados en UI (convención de mercado).
 * Frankfurter devuelve cuántas unidades de `currency` hay por 1 USD.
 */
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

function buildPair(def, usdRates) {
  const raw = usdRates[def.currency];
  if (raw == null || raw <= 0) return null;

  let rate;
  let decimals = 4;
  if (def.kind === 'usdPerUnit') {
    rate = 1 / raw;
    decimals = def.currency === 'EUR' || def.currency === 'GBP' ? 4 : 4;
  } else {
    rate = raw;
    decimals = def.currency === 'JPY' ? 2 : 4;
  }

  return {
    pair: def.pair,
    flags: def.flags,
    left: def.left,
    right: def.right,
    rate: roundRate(rate, decimals),
    decimals,
    subtitle: def.kind === 'usdPerUnit' ? 'USD por 1 unidad' : 'Unidades por 1 USD',
  };
}

async function fetchForexVsUsd() {
  const res = await axios.get(FRANKFURTER_URL, {
    params: { from: 'USD', to: CURRENCIES.join(',') },
    timeout: 8000,
    headers: { 'User-Agent': 'DashboardTC/1.0' },
  });

  const { rates, date } = res.data;
  const pairs = PAIR_DEFS.map(def => buildPair(def, rates)).filter(Boolean);

  return {
    base: 'USD',
    fecha: date,
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

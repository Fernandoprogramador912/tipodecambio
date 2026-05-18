const axios = require('axios');

const FRANKFURTER_BASE = 'https://api.frankfurter.app';
const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const CACHE_TTL_MS = 30 * 1000;

const CURRENCIES = ['EUR', 'BRL', 'GBP', 'JPY', 'CHF', 'CNY', 'MXN'];

const PAIR_DEFS = [
  { pair: 'EUR/USD', flags: ['eu', 'us'], left: 'Euro', right: 'USD', currency: 'EUR', kind: 'usdPerUnit', yahoo: 'EURUSD=X' },
  { pair: 'USD/BRL', flags: ['us', 'br'], left: 'USD', right: 'Real', currency: 'BRL', kind: 'unitsPerUsd', yahoo: 'USDBRL=X' },
  { pair: 'GBP/USD', flags: ['gb', 'us'], left: 'Libra', right: 'USD', currency: 'GBP', kind: 'usdPerUnit', yahoo: 'GBPUSD=X' },
  { pair: 'USD/JPY', flags: ['us', 'jp'], left: 'USD', right: 'Yen', currency: 'JPY', kind: 'unitsPerUsd', yahoo: 'USDJPY=X' },
  { pair: 'USD/CNY', flags: ['us', 'cn'], left: 'USD', right: 'Yuan', currency: 'CNY', kind: 'unitsPerUsd', yahoo: 'USDCNY=X' },
  { pair: 'USD/CHF', flags: ['us', 'ch'], left: 'USD', right: 'Franco', currency: 'CHF', kind: 'unitsPerUsd', yahoo: 'USDCHF=X' },
  { pair: 'USD/MXN', flags: ['us', 'mx'], left: 'USD', right: 'Peso MX', currency: 'MXN', kind: 'unitsPerUsd', yahoo: 'USDMXN=X' },
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

function buildPair(def, rate, ratePrev, meta = {}) {
  if (rate == null) return null;

  const decimals = pairDecimals(def);
  const rateRounded = roundRate(rate, decimals);
  const ratePrevRounded = ratePrev != null ? roundRate(ratePrev, decimals) : null;
  const move = foreignVsUsdMove(def, rateRounded, ratePrevRounded);
  const foreignName = def.kind === 'usdPerUnit' ? def.left : def.right;

  return {
    pair: def.pair,
    flags: def.flags,
    left: def.left,
    right: def.right,
    foreignName,
    rate: rateRounded,
    ratePrev: ratePrevRounded,
    cierreFecha: ratePrevRounded != null ? (meta.cierreLabel || 'sesión anterior') : null,
    changePct: move.changePct,
    changeAbs: move.changeAbs,
    vsUsd: move.vsUsd,
    decimals,
    subtitle: def.kind === 'usdPerUnit' ? 'USD por 1 unidad' : 'Unidades por 1 USD',
    asOf: meta.asOf || null,
  };
}

function rateFromUsdQuote(def, usdRates) {
  const raw = usdRates?.[def.currency];
  if (raw == null || raw <= 0) return null;
  return def.kind === 'usdPerUnit' ? 1 / raw : raw;
}

async function fetchYahooQuote(yahooSymbol) {
  const res = await axios.get(`${YAHOO_CHART_BASE}/${encodeURIComponent(yahooSymbol)}`, {
    params: { interval: '1m', range: '1d' },
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DashboardTC/1.0)' },
  });

  const meta = res.data?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) return null;

  return {
    price: meta.regularMarketPrice,
    prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    asOf: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : new Date().toISOString(),
  };
}

async function fetchFromYahoo() {
  const rows = await Promise.all(
    PAIR_DEFS.map(async def => {
      try {
        const q = await fetchYahooQuote(def.yahoo);
        if (!q) return null;
        return buildPair(def, q.price, q.prevClose, {
          asOf: q.asOf,
          cierreLabel: 'cierre sesión ant.',
        });
      } catch {
        return null;
      }
    }),
  );

  const pairs = rows.filter(Boolean);
  if (!pairs.length) return null;

  const fechaActualizacion = pairs
    .map(p => p.asOf)
    .filter(Boolean)
    .sort()
    .pop();

  return {
    base: 'USD',
    fecha: fechaActualizacion?.slice(0, 10) ?? null,
    fechaActualizacion,
    cierreReferencia: 'cierre sesión anterior',
    fuente: 'Yahoo Finance (FX mercado)',
    live: true,
    pairs,
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

async function fetchPreviousFrankfurterClose(sessionDate) {
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

async function fetchFromFrankfurter() {
  const latestRes = await axios.get(`${FRANKFURTER_BASE}/latest`, {
    params: { from: 'USD', to: CURRENCIES.join(',') },
    timeout: 8000,
    headers: { 'User-Agent': 'DashboardTC/1.0' },
  });

  const { rates, date } = latestRes.data;
  const prev = await fetchPreviousFrankfurterClose(date);

  const pairs = PAIR_DEFS.map(def => {
    const rate = rateFromUsdQuote(def, rates);
    const ratePrev = prev?.rates ? rateFromUsdQuote(def, prev.rates) : null;
    return buildPair(def, rate, ratePrev, {
      cierreLabel: prev?.date ?? null,
    });
  }).filter(Boolean);

  return {
    base: 'USD',
    fecha: date,
    fechaActualizacion: `${date}T00:00:00.000Z`,
    cierreReferencia: prev?.date ?? null,
    fuente: 'Frankfurter (BCE, referencia diaria)',
    live: false,
    pairs,
  };
}

async function fetchForexVsUsd() {
  try {
    const live = await fetchFromYahoo();
    if (live?.pairs?.length >= PAIR_DEFS.length - 1) {
      return live;
    }
  } catch (err) {
    console.warn('[forex] Yahoo:', err.message);
  }

  return fetchFromFrankfurter();
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

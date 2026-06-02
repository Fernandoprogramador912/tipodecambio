/**
 * Registra puntos del gráfico intradiario en el servidor (10:00–15:00 ART),
 * sin depender de que alguien tenga abierto el dashboard.
 */

const { record } = require('./historyService');

const RECORD_INTERVAL_MS = Number(process.env.TC_RECORD_INTERVAL_MS) || 30_000;
const ENABLED = process.env.ENABLE_FUTURES === 'true';

let lastRecordedAt = 0;
let recorderTimer = null;

function getARTMinutes() {
  const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return art.getUTCHours() * 60 + art.getUTCMinutes();
}

function isChartSessionART() {
  const m = getARTMinutes();
  return m >= 10 * 60 && m <= 15 * 60;
}

function maybeRecordTick(venta, asOfRaw) {
  if (!ENABLED || !isChartSessionART()) return false;
  const price = Number(venta);
  if (!Number.isFinite(price)) return false;

  const now = Date.now();
  if (now - lastRecordedAt < RECORD_INTERVAL_MS) return false;

  let ts;
  try {
    ts = asOfRaw ? new Date(asOfRaw).toISOString() : new Date().toISOString();
  } catch {
    ts = new Date().toISOString();
  }

  lastRecordedAt = now;
  record(price, price, ts);
  return true;
}

/** Toma el último precio A3 y lo persiste si corresponde. */
function pulseFromA3() {
  if (!ENABLED) return { recorded: false, reason: 'futures-disabled' };
  try {
    const a3 = require('../providers/a3MatrizWsProvider');
    const ult = a3.getDolarUsaUlt();
    if (ult?.price == null) {
      return { recorded: false, reason: 'no-price' };
    }
    if (ult._fromClose && !ult._stale) {
      return { recorded: false, reason: 'cierre-only' };
    }
    const recorded = maybeRecordTick(ult.price, ult.asOf);
    return {
      recorded,
      reason: recorded ? 'ok' : 'throttled-or-outside-session',
      price: ult.price,
    };
  } catch (err) {
    return { recorded: false, reason: err.message };
  }
}

function startTcIntradayRecorder() {
  if (!ENABLED || recorderTimer) return;
  pulseFromA3();
  recorderTimer = setInterval(pulseFromA3, RECORD_INTERVAL_MS);
}

function stopTcIntradayRecorder() {
  if (recorderTimer) {
    clearInterval(recorderTimer);
    recorderTimer = null;
  }
}

module.exports = {
  maybeRecordTick,
  pulseFromA3,
  isChartSessionART,
  startTcIntradayRecorder,
  stopTcIntradayRecorder,
};

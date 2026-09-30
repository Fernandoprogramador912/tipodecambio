/**
 * Recomendación de timing para cerrar cambio (comprar USD) durante la rueda.
 *
 * pLower = probabilidad de que el precio promedio del resto de la rueda quede por debajo del actual.
 *   pLower = pDayBear · P(baja después | día bajista) + (1 − pDayBear) · P(baja después | día no bajista)
 * - pDayBear: sesgo del día según estimación 09:00 + noticias de la mañana clasificadas.
 * - P(…|…): frecuencias históricas a esta misma hora en las ruedas guardadas.
 */

const tcHistory = require('./tcIntradayHistoryService');
const memory = require('./tcDayMemoryService');
const tcOutlook = require('./tcOutlookService');

const OPEN_MIN = 10 * 60;
const CLOSE_MIN = 15 * 60;
const WAIT_THRESHOLD = 0.6;
const CLOSE_THRESHOLD = 0.4;
const MIN_GROUP_SAMPLES = 4;
const SESSIONS_TTL_MS = 10 * 60 * 1000;

let sessionsCache = { key: null, at: 0, value: null };

function nowARTMinutes() {
  const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return art.getUTCHours() * 60 + art.getUTCMinutes();
}

/** Ruedas completas anteriores a `beforeDate`, con su cierre anterior encadenado. */
async function loadPastSessions(beforeDate) {
  const now = Date.now();
  if (sessionsCache.key === beforeDate && now - sessionsCache.at < SESSIONS_TTL_MS) {
    return sessionsCache.value;
  }
  const index = await tcHistory.listDays();
  const dates = (index.days || []).map(d => d.date).filter(d => d < beforeDate).sort().slice(-60);
  const days = [];
  for (let i = 0; i < dates.length; i += 8) {
    const batch = await Promise.all(dates.slice(i, i + 8).map(async d => ({
      date: d,
      pts: memory.sessionPoints((await tcHistory.getDay(d)).points),
    })));
    days.push(...batch);
  }
  const sessions = [];
  let prevClose = null;
  for (const d of days) {
    if (d.pts.length < 10) continue;
    const close = d.pts[d.pts.length - 1].venta;
    if (prevClose != null) sessions.push({ date: d.date, pts: d.pts, prevClose, close });
    prevClose = close;
  }
  sessionsCache = { key: beforeDate, at: now, value: sessions };
  return sessions;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function statsAt(sessions, artMin) {
  const groups = { bear: [], other: [] };
  for (const s of sessions) {
    const pNow = memory.priceAt(s.pts, artMin);
    const later = memory.laterStats(s.pts, artMin);
    if (pNow == null || !later) continue;
    const { direction } = memory.directionVs(s.prevClose, s.close);
    groups[direction === 'bajista' ? 'bear' : 'other'].push({
      lower: later.avg < pNow,
      drop: pNow - later.avg,
      minAt: later.minAt,
    });
  }
  const summarize = (arr, fallbackP) => {
    const n = arr.length;
    const lower = arr.filter(x => x.lower).length;
    const minAtMedian = median(arr.map(x => x.minAt));
    return {
      n,
      lower,
      pLower: n >= MIN_GROUP_SAMPLES ? lower / n : fallbackP,
      avgDrop: n ? +(arr.reduce((a, x) => a + x.drop, 0) / n).toFixed(2) : 0,
      minAtMedian,
      enough: n >= MIN_GROUP_SAMPLES,
    };
  };
  return { bear: summarize(groups.bear, 0.7), other: summarize(groups.other, 0.35) };
}

function pBearFromEstimate(estimate) {
  if (!estimate?.todayBias) return null;
  const conf = Math.max(50, Math.min(85, Number(estimate.confidence) || 60)) / 100;
  if (estimate.todayBias === 'bajista') return conf;
  if (estimate.todayBias === 'alcista') return 1 - conf;
  return 0.5;
}

function pBearFromNews(morning) {
  if (!morning || morning.newsScore == null) return null;
  return Math.max(0.15, Math.min(0.85, 0.5 - 0.35 * morning.newsScore));
}

/** Con la rueda abierta, ir por debajo del cierre anterior es evidencia de día bajista (−0,25% ≈ 0,8). */
function pBearFromPrice(priceNow, prevClose) {
  if (priceNow == null || !(prevClose > 0)) return null;
  const pct = ((priceNow - prevClose) / prevClose) * 100;
  return Math.max(0.2, Math.min(0.8, 0.5 - pct * 1.2));
}

function fmtMoney(n) {
  return `$${Math.abs(n).toFixed(2).replace('.', ',')}`;
}

function buildReason({ phase, morning, estimate, pDayBear, stats, action, priceNow, prevClose, waitUntil }) {
  const parts = [];
  if (morning) {
    const c = morning.counts || {};
    parts.push(`Noticias de la mañana: ${morning.label} (${c.bajista || 0} bajistas, ${c.alcista || 0} alcistas).`);
  } else {
    parts.push('Sin foto de noticias de la mañana (se toma a las 09:00 con el servidor prendido).');
  }
  if (estimate?.todayBias) parts.push(`Estimación 09:00: ${estimate.todayBias} (${estimate.confidence ?? '—'}%).`);
  if (phase === 'in_progress' && priceNow != null && prevClose != null) {
    const diff = priceNow - prevClose;
    parts.push(`Ahora ${diff <= 0 ? 'abajo' : 'arriba'} del cierre anterior por ${fmtMoney(diff)}.`);
  }
  const g = pDayBear >= 0.5 ? stats.bear : stats.other;
  if (g.enough) {
    const tipo = pDayBear >= 0.5 ? 'bajistas' : 'no bajistas';
    parts.push(`En días ${tipo}, desde esta hora el TC siguió bajando ${g.lower} de ${g.n} veces.`);
  }
  if (waitUntil) parts.push(`Mínimo típico hacia las ${waitUntil}.`);
  return parts.join(' ');
}

const LABELS = {
  esperar: 'ESPERAR',
  cerrar: 'CERRAR AHORA',
  indiferente: 'SIN VENTAJA CLARA',
};

/**
 * @param {string} dateStr
 * @param {{ log?: boolean, at?: string }} opts  at='HH:MM' simula la recomendación a esa hora (sin guardar)
 */
async function getRecommendation(dateStr = memory.todayART(), { log = false, at = null } = {}) {
  const today = memory.todayART();
  const [atH, atM] = /^\d{2}:\d{2}$/.test(at || '') ? at.split(':').map(Number) : [];
  const simulated = Number.isFinite(atH) && atH * 60 + atM >= OPEN_MIN && atH * 60 + atM < CLOSE_MIN;
  const nowMin = simulated ? atH * 60 + atM : nowARTMinutes();
  let phase = 'historical';
  if (simulated) {
    phase = 'in_progress';
    log = false;
  } else if (dateStr === today) {
    phase = nowMin < OPEN_MIN ? 'pre_open' : (nowMin >= CLOSE_MIN ? 'closed' : 'in_progress');
  }

  const [row, stored, learning] = await Promise.all([
    memory.getRow(dateStr),
    tcOutlook.getStoredOutlook(dateStr).catch(() => null),
    memory.learningStats().catch(() => null),
  ]);
  const morning = row?.morning || null;
  const estimate = stored?.estimate || null;

  if (phase === 'closed' || phase === 'historical') {
    return {
      ok: true,
      date: dateStr,
      phase,
      action: null,
      label: 'RUEDA CERRADA',
      reason: row?.outcome
        ? `Cerró ${row.outcome.direction || '—'} (${row.outcome.changeVsPrevPct ?? '—'}% vs cierre anterior). Mínimo ${row.outcome.min} a las ${row.outcome.minAt}.`
        : 'La rueda terminó. El resultado se registra a las 15:30.',
      morning: morning ? { newsScore: morning.newsScore, label: morning.label, counts: morning.counts, summary: morning.summary } : null,
      recos: row?.recos || [],
      learning,
    };
  }

  const refMin = phase === 'pre_open' ? OPEN_MIN + 5 : nowMin;
  const [sessions, dayData, ant] = await Promise.all([
    loadPastSessions(dateStr),
    phase === 'in_progress' ? tcHistory.getDay(dateStr) : null,
    tcHistory.getCierreAnterior(dateStr).catch(() => null),
  ]);
  const pts = dayData ? memory.sessionPoints(dayData.points).filter(p => p.min <= nowMin) : [];
  const priceNow = pts.length ? pts[pts.length - 1].venta : null;
  const prevClose = ant?.cierreValor ?? null;

  const pEst = pBearFromEstimate(estimate);
  const pNews = pBearFromNews(morning);
  const pPrice = pBearFromPrice(priceNow, prevClose);
  const inputs = [pEst, pNews, pPrice].filter(v => v != null);
  const pDayBear = inputs.length ? inputs.reduce((a, b) => a + b, 0) / inputs.length : 0.5;

  const stats = statsAt(sessions, refMin);
  const pLower = pDayBear * stats.bear.pLower + (1 - pDayBear) * stats.other.pLower;
  const expectedDrop = pDayBear * stats.bear.avgDrop + (1 - pDayBear) * stats.other.avgDrop;

  let action = 'indiferente';
  if (pLower >= WAIT_THRESHOLD) action = 'esperar';
  else if (pLower <= CLOSE_THRESHOLD) action = 'cerrar';

  const waitGroup = stats.bear.enough ? stats.bear : stats.other;
  const waitUntil = action === 'esperar' && waitGroup.minAtMedian && waitGroup.minAtMedian > memory.timeLabel(refMin + 10)
    ? waitGroup.minAtMedian
    : null;
  const reco = {
    ok: true,
    date: dateStr,
    phase,
    simulated,
    nowART: memory.timeLabel(nowMin),
    refART: memory.timeLabel(refMin),
    priceNow,
    prevClose,
    vsPrevClose: priceNow != null && prevClose != null ? +(priceNow - prevClose).toFixed(2) : null,
    action,
    label: LABELS[action],
    pLower: +pLower.toFixed(2),
    pDayBear: +pDayBear.toFixed(2),
    expectedDrop: +expectedDrop.toFixed(2),
    waitUntil,
    inputs: {
      estimate: estimate ? { bias: estimate.todayBias, confidence: estimate.confidence, pBear: pEst } : null,
      price: pPrice != null ? { vsPrevClose: +(priceNow - prevClose).toFixed(2), pBear: +pPrice.toFixed(2) } : null,
      news: morning ? { newsScore: morning.newsScore, label: morning.label, counts: morning.counts, pBear: pNews, late: morning.late } : null,
    },
    stats,
    sessionsUsed: sessions.length,
    reason: buildReason({ phase, morning, estimate, pDayBear, stats, action, priceNow, prevClose, waitUntil }),
    morningSummary: morning?.summary || null,
    recos: row?.recos || [],
    learning,
    disclaimer: 'Estimación estadística orientativa, no garantiza el movimiento del TC.',
  };

  if (log && phase === 'in_progress' && priceNow != null) {
    await memory.logReco(dateStr, reco).catch(err => console.warn('[tc-timing] logReco:', err.message));
  }
  return reco;
}

module.exports = { getRecommendation };

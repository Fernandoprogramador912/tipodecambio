/**
 * Recomendación de timing para cerrar cambio (comprar USD) durante la rueda.
 *
 * 1) Estado: ruedas pasadas que a esta misma hora estaban en una situación parecida vs su cierre
 *    anterior (ponderadas por similitud, con shrinkage hacia el total para pocas muestras).
 *    De ahí salen P(el promedio del resto de la rueda queda abajo), ahorro esperado y riesgo de suba.
 * 2) Sesgo del día (estimación 09:00 + noticias de la mañana): inclina el resultado, con más peso
 *    temprano y menos a medida que avanza la rueda.
 * 3) ESPERAR solo si además el ahorro esperado supera un mínimo; si no, no hay ventaja real.
 */

const tcHistory = require('./tcIntradayHistoryService');
const memory = require('./tcDayMemoryService');
const tcOutlook = require('./tcOutlookService');

const OPEN_MIN = 10 * 60;
const CLOSE_MIN = 15 * 60;
const WAIT_P = 0.6;
const CLOSE_P = 0.4;
const MIN_WAIT_GAIN = 0.5; // $/USD mínimo para que valga la pena esperar
const MAX_WAIT_COST = -0.3; // si esperar cuesta más que esto, conviene cerrar
const SIMILARITY_SIGMA_PCT = 0.1; // ancho de la similitud en % vs cierre anterior
const SHRINK_K = 3; // muestras "virtuales" del total para estabilizar grupos chicos
const NEWS_WEIGHT_OPEN = 0.6;
const NEWS_WEIGHT_CLOSE = 0.15;
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
    if (prevClose != null) sessions.push({ date: d.date, pts: d.pts, prevClose });
    prevClose = d.pts[d.pts.length - 1].venta;
  }
  sessionsCache = { key: beforeDate, at: now, value: sessions };
  return sessions;
}

/** Qué pasó después de `artMin` en cada rueda pasada. */
function samplesAt(sessions, artMin) {
  const out = [];
  for (const s of sessions) {
    const pNow = memory.priceAt(s.pts, artMin);
    const later = s.pts.filter(p => p.min > artMin);
    if (pNow == null || later.length < 2) continue;
    const avg = later.reduce((a, p) => a + p.venta, 0) / later.length;
    const low = later.reduce((m, p) => (p.venta < m.venta ? p : m), later[0]);
    const high = Math.max(...later.map(p => p.venta));
    out.push({
      date: s.date,
      vsPrevPct: ((pNow - s.prevClose) / s.prevClose) * 100,
      lower: avg < pNow,
      lateral: Math.abs(avg - pNow) <= 0.5,
      saving: pNow - avg, // >0: esperar convenía
      upRisk: high - pNow,
      bestDrop: pNow - low.venta,
      minAt: memory.timeLabel(low.min),
    });
  }
  return out;
}

function weightedMedian(items) {
  const sorted = items.filter(x => x.w > 0).sort((a, b) => a.v.localeCompare(b.v));
  const total = sorted.reduce((a, x) => a + x.w, 0);
  let acc = 0;
  for (const x of sorted) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return null;
}

/** Estadística ponderada por similitud con la situación actual (vsPrevPct null = sin estado). */
function stateStats(samples, vsPrevPct) {
  const n = samples.length;
  if (!n) return null;
  const mean = f => samples.reduce((a, s) => a + f(s), 0) / n;
  const overall = { pLower: mean(s => (s.lower ? 1 : 0)), saving: mean(s => s.saving), upRisk: mean(s => s.upRisk), bestDrop: mean(s => s.bestDrop) };

  const weighted = samples.map(s => ({
    s,
    w: vsPrevPct == null ? 1 : Math.exp(-((s.vsPrevPct - vsPrevPct) ** 2) / (2 * SIMILARITY_SIGMA_PCT ** 2)),
  }));
  const W = weighted.reduce((a, x) => a + x.w, 0);
  const shrink = (f, base) => (weighted.reduce((a, x) => a + x.w * f(x.s), 0) + SHRINK_K * base) / (W + SHRINK_K);
  const similar = weighted.filter(x => x.w >= 0.5).map(x => x.s);

  return {
    pLower: shrink(s => (s.lower ? 1 : 0), overall.pLower),
    saving: shrink(s => s.saving, overall.saving),
    upRisk: shrink(s => s.upRisk, overall.upRisk),
    bestDrop: shrink(s => s.bestDrop, overall.bestDrop),
    scale: mean(s => Math.abs(s.saving)),
    effectiveN: +W.toFixed(1),
    similar: {
      n: similar.length,
      lower: similar.filter(s => s.lower).length,
      lateral: similar.filter(s => s.lateral).length,
      dates: similar.map(s => s.date),
    },
    minAtMedian: weightedMedian(weighted.filter(x => x.s.lower).map(x => ({ v: x.s.minAt, w: x.w }))),
    total: n,
  };
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

/** Peso del sesgo de noticias/estimación: alto a la apertura, bajo hacia el cierre. */
function newsWeightAt(artMin) {
  const t = Math.max(0, Math.min(1, (artMin - OPEN_MIN) / (CLOSE_MIN - OPEN_MIN)));
  return NEWS_WEIGHT_OPEN + (NEWS_WEIGHT_CLOSE - NEWS_WEIGHT_OPEN) * t;
}

function fmtMoney(n) {
  return `$${Math.abs(n).toFixed(2).replace('.', ',')}`;
}

function buildReason({ phase, morning, estimate, st, priceNow, prevClose, expectedSaving, action }) {
  const parts = [];
  if (morning) {
    const c = morning.counts || {};
    parts.push(`Noticias de la mañana: ${morning.label} (${c.bajista || 0} bajistas, ${c.alcista || 0} alcistas).`);
  } else {
    parts.push('Sin foto de noticias de la mañana.');
  }
  if (estimate?.todayBias) parts.push(`Estimación 09:00: ${estimate.todayBias} (${estimate.confidence ?? '—'}%).`);

  if (phase === 'in_progress' && priceNow != null && prevClose != null) {
    const diff = priceNow - prevClose;
    const where = Math.abs(diff) < 0.5 ? 'casi igual al cierre anterior' : `${fmtMoney(diff)} ${diff < 0 ? 'abajo' : 'arriba'} del cierre anterior`;
    parts.push(`Ahora está ${where}.`);
    if (st.similar.n) {
      parts.push(`Otros ${st.similar.n} días en esa situación a esta hora: bajó después en ${st.similar.lower}, quedó lateral en ${st.similar.lateral}.`);
    }
  } else if (phase === 'pre_open') {
    parts.push(`Desde la apertura, en ${st.total} ruedas el promedio del resto del día quedó abajo en ${Math.round(st.pLower * 100)}% de los casos.`);
  }

  if (action === 'indiferente') {
    parts.push(`Esperar ahorraría ~${fmtMoney(expectedSaving)} y el riesgo de rebote es ~${fmtMoney(st.upRisk)}: cerrar ahora o más tarde da parecido.`);
  } else if (action === 'cerrar') {
    parts.push(`Esperar tiende a salir más caro (riesgo de suba ~${fmtMoney(st.upRisk)}).`);
  }
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
  const vsPrevPct = priceNow != null && prevClose > 0 ? ((priceNow - prevClose) / prevClose) * 100 : null;

  const st = stateStats(samplesAt(sessions, refMin), vsPrevPct);
  if (!st) {
    return { ok: true, date: dateStr, phase, action: 'indiferente', label: LABELS.indiferente, reason: 'Todavía no hay suficientes ruedas guardadas para comparar.', learning };
  }

  const pEst = pBearFromEstimate(estimate);
  const pNews = pBearFromNews(morning);
  const inputs = [pEst, pNews].filter(v => v != null);
  const pDayBear = inputs.length ? inputs.reduce((a, b) => a + b, 0) / inputs.length : 0.5;
  const tilt = (pDayBear - 0.5) * newsWeightAt(refMin);

  const pLower = Math.max(0.02, Math.min(0.98, st.pLower + tilt));
  const expectedSaving = st.saving + 2 * tilt * st.scale;

  let action = 'indiferente';
  if (pLower >= WAIT_P && expectedSaving >= MIN_WAIT_GAIN) action = 'esperar';
  else if (pLower <= CLOSE_P && expectedSaving <= MAX_WAIT_COST) action = 'cerrar';

  const waitUntil = action === 'esperar' && st.minAtMedian && st.minAtMedian > memory.timeLabel(refMin + 10)
    ? st.minAtMedian
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
    expectedSaving: +expectedSaving.toFixed(2),
    upRisk: +st.upRisk.toFixed(2),
    bestDrop: +st.bestDrop.toFixed(2),
    waitUntil,
    inputs: {
      estimate: estimate ? { bias: estimate.todayBias, confidence: estimate.confidence, pBear: pEst } : null,
      news: morning ? { newsScore: morning.newsScore, label: morning.label, counts: morning.counts, pBear: pNews, late: morning.late } : null,
      newsWeight: +newsWeightAt(refMin).toFixed(2),
    },
    state: {
      vsPrevPct: vsPrevPct != null ? +vsPrevPct.toFixed(3) : null,
      pLower: +st.pLower.toFixed(2),
      saving: +st.saving.toFixed(2),
      effectiveN: st.effectiveN,
      similar: st.similar,
    },
    sessionsUsed: sessions.length,
    reason: buildReason({ phase, morning, estimate, st, priceNow, prevClose, expectedSaving, action }),
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

/**
 * Memoria diaria para aprender de cada rueda:
 * - morning: titulares disponibles antes de la rueda (foto 09:00) clasificados alcista/bajista.
 * - outcome: qué hizo el TC ese día contra el cierre anterior (cierre, mínimo, hora del mínimo…).
 * - after: cierres D+1 y D+3 (se completan en ruedas posteriores).
 * - recos: recomendaciones ESPERAR/CERRAR emitidas y su evaluación al cierre.
 * Guarda en Supabase (tabla tc_day_memory) con fallback a archivo local.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const tcHistory = require('./tcIntradayHistoryService');

const MEMORY_FILE = path.join(__dirname, '../../data/tc-day-memory.json');
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_TABLE = process.env.SUPABASE_TC_MEMORY_TABLE || 'tc_day_memory';
let supabaseUsable = Boolean(SUPABASE_URL && SUPABASE_KEY);

const OPEN_MIN = 10 * 60;
const CLOSE_MIN = 15 * 60;
const DIRECTION_PCT = 0.1; // |var vs cierre anterior| < 0.1% = lateral
const MAX_HEADLINES = 15;

function todayART() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function timeLabel(artMin) {
  return `${String(Math.floor(artMin / 60)).padStart(2, '0')}:${String(artMin % 60).padStart(2, '0')}`;
}

// ── Storage ──

function readFile() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return {};
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeFile(data) {
  try {
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
  } catch { /* entornos read-only */ }
}

async function supabaseRequest(method, pathSuffix, data, extraHeaders = {}) {
  const res = await axios.request({
    method,
    url: `${SUPABASE_URL}/rest/v1/${pathSuffix}`,
    data,
    timeout: 10_000,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
  return res.data;
}

async function withStorage(supabaseFn, localFn) {
  if (supabaseUsable) {
    try {
      return await supabaseFn();
    } catch (err) {
      const code = err.response?.data?.code;
      if (err.response?.status === 404 || code === 'PGRST205' || code === '42P01') {
        supabaseUsable = false;
        console.warn(`[tc-memory] Tabla ${SUPABASE_TABLE} no existe en Supabase; uso archivo local (ver scripts/tc-day-memory-supabase.sql).`);
      } else {
        console.warn('[tc-memory] Supabase falló, uso archivo local:', err.message);
      }
    }
  }
  return localFn();
}

async function getRow(dateStr) {
  return withStorage(async () => {
    const rows = await supabaseRequest('get',
      `${SUPABASE_TABLE}?session_date=eq.${dateStr}&select=session_date,data,updated_at&limit=1`);
    return Array.isArray(rows) && rows[0] ? { date: dateStr, ...rows[0].data } : null;
  }, () => {
    const row = readFile()[dateStr];
    return row ? { date: dateStr, ...row } : null;
  });
}

/** Merge superficial por clave (morning / outcome / after / recos). */
async function saveRow(dateStr, patch) {
  const existing = (await getRow(dateStr)) || {};
  delete existing.date;
  const data = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  return withStorage(async () => {
    await supabaseRequest('post', `${SUPABASE_TABLE}?on_conflict=session_date`, {
      session_date: dateStr,
      data,
      updated_at: data.updatedAt,
    }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    return { date: dateStr, ...data, storage: 'supabase' };
  }, () => {
    const store = readFile();
    store[dateStr] = data;
    const keys = Object.keys(store).sort().reverse();
    if (keys.length > 250) keys.slice(250).forEach(k => delete store[k]);
    writeFile(store);
    return { date: dateStr, ...data, storage: 'local-file' };
  });
}

async function listRows(limit = 60) {
  return withStorage(async () => {
    const rows = await supabaseRequest('get',
      `${SUPABASE_TABLE}?select=session_date,data&order=session_date.desc&limit=${limit}`);
    return (rows || []).map(r => ({ date: r.session_date, ...r.data }));
  }, () => {
    const store = readFile();
    return Object.keys(store).sort().reverse().slice(0, limit).map(date => ({ date, ...store[date] }));
  });
}

// ── Noticias de la mañana ──

const BEARISH_RE = /\b(baja|bajan|cae|caen|cay[oó]|retrocede|afloja|liquidaci[oó]n|ingreso de d[oó]lares|compr[oó].{0,20}reservas|desembolso|super[aá]vit|riesgo pa[ií]s (baja|baj[oó]|cae|perfora)|bonos (suben|se recuperan)|calma|alivio|interviene|techo|precio m[aá]ximo|controlar el d[oó]lar)\b/i;
const BULLISH_RE = /\b(sube|suben|salta|dispara|trepa|presi[oó]n|demanda de d[oó]lares|reservas caen|vencimientos?|incertidumbre|tensi[oó]n|devaluaci[oó]n|riesgo pa[ií]s (sube|salta))\b/i;

function heuristicEffect(title) {
  const bear = BEARISH_RE.test(title);
  const bull = BULLISH_RE.test(title);
  if (bear && !bull) return 'bajista';
  if (bull && !bear) return 'alcista';
  return 'neutro';
}

async function classifyWithOpenAI(headlines) {
  const list = headlines.map((h, i) => `${i}. [${h.source || '—'}] ${h.title}`).join('\n');
  const res = await axios.post(OPENAI_URL, {
    model: MODEL,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Sos un trader de tipo de cambio mayorista USD/ARS (rueda 10:00-15:00 ART).
Para cada titular, decidí qué efecto tendría HOY sobre el dólar mayorista:
"alcista" = el TC sube (peso se debilita), "bajista" = el TC baja (peso se fortalece), "neutro" = sin efecto claro en el día.
Juzgá la noticia concreta, no la situación estructural de Argentina.
Guía del mercado argentino:
- Gobierno/Tesoro/BCRA interviniendo, vendiendo dólares, marcando techo o "precio máximo", "el foco es controlar el dólar" → bajista (contiene el TC).
- Riesgo país baja, bonos suben, "alivio", mercado tranquilo → bajista leve.
- Riesgo país sube, bonos caen, tensión, rumores de devaluación o de cambio de bandas → alcista.
- BCRA/Tesoro compra dólares en el mercado → alcista leve (suma demanda); "reservas caen" sin otra acción → neutro o alcista leve.
- Liquidación fuerte del agro, desembolsos (FMI, organismos, colocación de deuda) → bajista.
- "El dólar cedió/bajó ayer" → bajista leve (inercia); "el dólar subió ayer" → alcista leve.
- Inflación/IPC/actividad: neutro en el día salvo que el dato se publique hoy y sorprenda.
- Política sin consecuencia de mercado (viajes, agenda, cargos) → neutro.
weight: 1 = leve, 2 = moderado, 3 = fuerte (ej. intervención oficial, liquidación del agro, desembolsos, cambios de régimen, datos del día).
Respondé SOLO JSON: {"items":[{"i":0,"effect":"alcista|bajista|neutro","weight":1,"reason":"máx 12 palabras"}],"summary":"1-2 oraciones sobre el tono de la mañana para el dólar"}`,
      },
      { role: 'user', content: list },
    ],
  }, {
    timeout: 30_000,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
  });
  const content = res.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI no devolvió contenido');
  return JSON.parse(content);
}

function scoreHeadlines(headlines) {
  let num = 0;
  let den = 0;
  const counts = { alcista: 0, bajista: 0, neutro: 0 };
  for (const h of headlines) {
    const sign = h.effect === 'alcista' ? 1 : (h.effect === 'bajista' ? -1 : 0);
    num += sign * h.weight;
    den += h.weight;
    counts[h.effect] = (counts[h.effect] || 0) + 1;
  }
  const score = den ? +(num / den).toFixed(2) : 0;
  const label = score <= -0.2 ? 'bajista' : (score >= 0.2 ? 'alcista' : 'mixto');
  return { score, label, counts };
}

/**
 * Foto de noticias de la mañana. Solo titulares publicados antes de las 10:00 ART del día,
 * así una captura tardía no “ve” noticias posteriores a la apertura.
 */
async function captureMorning(dateStr, newsItems = [], { force = false } = {}) {
  const existing = await getRow(dateStr);
  if (existing?.morning && !force) {
    return { captured: false, reason: 'already-captured', date: dateStr, morning: existing.morning };
  }

  const cutoffMs = Date.parse(`${dateStr}T13:00:00Z`);
  const pool = (newsItems || [])
    .filter(n => n?.title)
    .filter(n => {
      const t = Date.parse(n.pubDate);
      return !Number.isFinite(t) || t <= cutoffMs;
    })
    .filter(n => n.impact === 'muy_alto' || n.impact === 'alto' || n.impact === 'medio' || (n.score || 0) >= 3)
    .slice(0, MAX_HEADLINES)
    .map(n => ({ title: n.title, source: n.source, impact: n.impact, pubDate: n.pubDate, link: n.link }));

  if (!pool.length) return { captured: false, reason: 'no-news', date: dateStr };

  let method = 'heuristic';
  let summary = '';
  let headlines = pool.map(h => ({ ...h, effect: heuristicEffect(h.title), weight: 1, reason: '' }));

  if (process.env.OPENAI_API_KEY) {
    try {
      const parsed = await classifyWithOpenAI(pool);
      const byIdx = new Map((parsed.items || []).map(it => [Number(it.i), it]));
      headlines = pool.map((h, i) => {
        const it = byIdx.get(i) || {};
        const effect = ['alcista', 'bajista', 'neutro'].includes(it.effect) ? it.effect : 'neutro';
        const weight = Math.max(1, Math.min(3, Number(it.weight) || 1));
        return { ...h, effect, weight, reason: String(it.reason || '').slice(0, 120) };
      });
      summary = String(parsed.summary || '').slice(0, 400);
      method = 'openai';
    } catch (err) {
      console.warn('[tc-memory] Clasificación OpenAI falló, uso heurística:', err.message);
    }
  }

  const { score, label, counts } = scoreHeadlines(headlines);
  const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const capturedMin = art.getUTCHours() * 60 + art.getUTCMinutes();
  const morning = {
    capturedAt: new Date().toISOString(),
    capturedART: timeLabel(capturedMin),
    late: dateStr === todayART() && capturedMin >= OPEN_MIN,
    method,
    newsScore: score,
    label,
    counts,
    summary,
    headlines,
  };
  const saved = await saveRow(dateStr, { morning });
  return { captured: true, date: dateStr, morning, storage: saved.storage };
}

// ── Resultado del día ──

function sessionPoints(points = []) {
  return points
    .map(p => ({ venta: Number(p.venta), min: tcHistory.toARTMin(p.ts) }))
    .filter(p => Number.isFinite(p.venta) && p.min >= OPEN_MIN && p.min <= CLOSE_MIN)
    .sort((a, b) => a.min - b.min);
}

/** Precio vigente a una hora (último punto dentro de los 15 min previos). */
function priceAt(pts, artMin) {
  let best = null;
  for (const p of pts) {
    if (p.min > artMin) break;
    best = p;
  }
  return best && artMin - best.min <= 15 ? best.venta : null;
}

function laterStats(pts, artMin) {
  const later = pts.filter(p => p.min > artMin);
  if (later.length < 2) return null;
  const avg = later.reduce((a, p) => a + p.venta, 0) / later.length;
  const low = later.reduce((m, p) => (p.venta < m.venta ? p : m), later[0]);
  return { avg: +avg.toFixed(2), min: low.venta, minAt: timeLabel(low.min), close: later[later.length - 1].venta };
}

function directionVs(prev, close) {
  if (!(prev > 0) || close == null) return { direction: null, pct: null };
  const pct = +(((close - prev) / prev) * 100).toFixed(3);
  if (Math.abs(pct) < DIRECTION_PCT) return { direction: 'lateral', pct };
  return { direction: pct > 0 ? 'alcista' : 'bajista', pct };
}

function evaluateRecos(recos = [], pts) {
  return recos.map(r => {
    const [hh, mm] = String(r.timeART || '').split(':').map(Number);
    const at = hh * 60 + mm;
    const later = Number.isFinite(at) ? laterStats(pts, at) : null;
    if (!later || !(r.price > 0)) return { ...r, eval: null };
    const saved = +(r.price - later.avg).toFixed(2); // >0: esperar convenía
    let correct = null;
    if (r.action === 'esperar') correct = saved > 0;
    else if (r.action === 'cerrar') correct = saved <= 0;
    return { ...r, eval: { laterAvg: later.avg, laterMin: later.min, laterMinAt: later.minAt, saved, correct } };
  });
}

/** Registra cómo terminó la rueda y evalúa las recomendaciones emitidas ese día. */
async function recordOutcome(dateStr) {
  const [day, ant, row] = await Promise.all([
    tcHistory.getDay(dateStr),
    tcHistory.getCierreAnterior(dateStr).catch(() => null),
    getRow(dateStr),
  ]);
  const pts = sessionPoints(day.points);
  if (pts.length < 5) return { recorded: false, reason: 'pocos-puntos', date: dateStr };

  const prevClose = ant?.cierreValor ?? null;
  const open = pts[0].venta;
  const close = pts[pts.length - 1].venta;
  const low = pts.reduce((m, p) => (p.venta < m.venta ? p : m), pts[0]);
  const high = pts.reduce((m, p) => (p.venta > m.venta ? p : m), pts[0]);
  const { direction, pct } = directionVs(prevClose, close);
  const p1030 = priceAt(pts, 10 * 60 + 30);
  const after1030 = laterStats(pts, 10 * 60 + 30);

  const outcome = {
    prevClose,
    prevCloseDate: ant?.cierreFecha || null,
    open,
    close,
    min: low.venta,
    minAt: timeLabel(low.min),
    max: high.venta,
    maxAt: timeLabel(high.min),
    direction,
    changeVsPrevPct: pct,
    price1030: p1030,
    waitFrom1030: p1030 != null && after1030 ? +(p1030 - after1030.avg).toFixed(2) : null,
    recordedAt: new Date().toISOString(),
  };

  const recos = evaluateRecos(row?.recos || [], pts);
  const saved = await saveRow(dateStr, { outcome, recos });
  await backfillAfter().catch(err => console.warn('[tc-memory] backfill D+1/D+3:', err.message));
  return { recorded: true, date: dateStr, outcome, recos, storage: saved.storage };
}

/** Completa cierres D+1 y D+3 en filas anteriores que todavía no los tienen. */
async function backfillAfter() {
  const rows = (await listRows(30)).filter(r => r.outcome?.close != null && !r.after?.d3);
  if (!rows.length) return { updated: 0 };
  const index = await tcHistory.listDays();
  const dates = (index.days || []).filter(d => (d.pointCount || 0) >= 5).map(d => d.date).sort();
  let updated = 0;
  for (const row of rows) {
    const later = dates.filter(d => d > row.date).slice(0, 3);
    const after = { ...(row.after || {}) };
    for (const [key, idx] of [['d1', 0], ['d3', 2]]) {
      if (after[key] || !later[idx] || later[idx] >= todayART()) continue;
      const pts = sessionPoints((await tcHistory.getDay(later[idx])).points);
      if (!pts.length) continue;
      const close = pts[pts.length - 1].venta;
      after[key] = { date: later[idx], close, ...directionVs(row.outcome.close, close) };
    }
    if (JSON.stringify(after) !== JSON.stringify(row.after || {})) {
      await saveRow(row.date, { after });
      updated++;
    }
  }
  return { updated };
}

// ── Recomendaciones emitidas ──

const RECO_LOG_MIN_GAP_MS = 15 * 60 * 1000;

/** Guarda la recomendación vigente (máx. una cada 15 min salvo que cambie la acción). */
async function logReco(dateStr, reco) {
  const row = await getRow(dateStr);
  const recos = Array.isArray(row?.recos) ? row.recos : [];
  const last = recos[recos.length - 1];
  if (last && last.action === reco.action && Date.now() - Date.parse(last.at) < RECO_LOG_MIN_GAP_MS) {
    return { logged: false };
  }
  recos.push({
    at: new Date().toISOString(),
    timeART: reco.nowART,
    price: reco.priceNow,
    action: reco.action,
    pLower: reco.pLower,
    pDayBear: reco.pDayBear,
  });
  await saveRow(dateStr, { recos });
  return { logged: true };
}

/** Días con noticias de la mañana parecidas (por score) y su resultado. */
async function similarDays(dateStr, newsScore, limit = 5) {
  if (newsScore == null) return [];
  const rows = await listRows(120);
  return rows
    .filter(r => r.date < dateStr && r.morning && r.outcome?.direction)
    .sort((a, b) => Math.abs(a.morning.newsScore - newsScore) - Math.abs(b.morning.newsScore - newsScore))
    .slice(0, limit)
    .map(r => ({
      date: r.date,
      newsScore: r.morning.newsScore,
      newsLabel: r.morning.label,
      direction: r.outcome.direction,
      changeVsPrevPct: r.outcome.changeVsPrevPct,
      minAt: r.outcome.minAt,
    }));
}

/** Resumen del aprendizaje acumulado (para mostrar en la tarjeta). */
async function learningStats() {
  const rows = await listRows(120);
  let evaluated = 0;
  let hits = 0;
  let savedSum = 0;
  for (const r of rows) {
    for (const reco of r.recos || []) {
      if (reco.eval?.correct == null) continue;
      evaluated++;
      if (reco.eval.correct) hits++;
      if (reco.action === 'esperar') savedSum += reco.eval.saved;
    }
  }
  return {
    memoryDays: rows.length,
    newsDays: rows.filter(r => r.morning).length,
    outcomeDays: rows.filter(r => r.outcome).length,
    recoEvaluated: evaluated,
    recoHits: hits,
    recoHitPct: evaluated ? Math.round((hits / evaluated) * 100) : null,
    savedByWaiting: +savedSum.toFixed(2),
  };
}

module.exports = {
  getRow,
  listRows,
  captureMorning,
  recordOutcome,
  backfillAfter,
  logReco,
  similarDays,
  learningStats,
  sessionPoints,
  priceAt,
  laterStats,
  directionVs,
  timeLabel,
  todayART,
};

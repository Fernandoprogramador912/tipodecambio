/**
 * Análisis de escenario USD/ARS con OpenAI.
 * Combina rueda del día, historial reciente, noticias y un marco 2023-2026.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ARGENTINA_FX_CONTEXT = require('../data/argentinaFxContext');
const tcHistory = require('./tcIntradayHistoryService');
const newsArchive = require('./newsArchiveService');

const STORE_FILE = path.join(__dirname, '../../data/tc-outlook.json');
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_TABLE = process.env.SUPABASE_TC_OUTLOOK_TABLE || 'tc_day_outlook';
const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_KEY);

function todayART() {
  const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return art.toISOString().slice(0, 10);
}

function hasOpenAI() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function readFile() {
  try {
    if (!fs.existsSync(STORE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeFile(data) {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
  } catch { /* entornos read-only */ }
}

async function supabaseRequest(method, pathSuffix, data, extraHeaders = {}) {
  const res = await axios.request({
    method,
    url: `${SUPABASE_URL}/rest/v1/${pathSuffix}`,
    data,
    timeout: 12_000,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
  return res.data;
}

async function getStored(dateStr) {
  if (SUPABASE_CONFIGURED) {
    try {
      const rows = await supabaseRequest(
        'get',
        `${SUPABASE_TABLE}?session_date=eq.${dateStr}&select=session_date,analysis,generated_at&limit=1`
      );
      if (Array.isArray(rows) && rows[0]) {
        return {
          date: rows[0].session_date,
          analysis: rows[0].analysis,
          generatedAt: rows[0].generated_at,
          storage: 'supabase',
        };
      }
    } catch { /* fallback local */ }
  }
  const store = readFile();
  const row = store[dateStr];
  return row
    ? { date: dateStr, analysis: row.analysis, generatedAt: row.generatedAt, storage: 'local-file' }
    : null;
}

async function saveStored(dateStr, analysis) {
  const generatedAt = new Date().toISOString();
  const payload = { analysis, generatedAt };

  if (SUPABASE_CONFIGURED) {
    try {
      await supabaseRequest('post', `${SUPABASE_TABLE}?on_conflict=session_date`, {
        session_date: dateStr,
        analysis,
        generated_at: generatedAt,
      }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
      return { date: dateStr, ...payload, storage: 'supabase' };
    } catch (err) {
      console.warn('[tc-outlook] Supabase falló, usando archivo local:', err.message);
    }
  }

  const store = readFile();
  store[dateStr] = payload;
  const keys = Object.keys(store).sort().reverse();
  if (keys.length > 90) keys.slice(90).forEach(k => delete store[k]);
  writeFile(store);
  return { date: dateStr, ...payload, storage: 'local-file' };
}

function compactNews(items = []) {
  return items.slice(0, 12).map(n => ({
    title: n.title,
    source: n.source,
    impact: n.impact,
    score: n.score,
    pubDate: n.pubDate,
  }));
}

async function buildContext(dateStr) {
  const [index, todaySummary, insights] = await Promise.all([
    tcHistory.listDays(),
    tcHistory.getDaySummary(dateStr),
    tcHistory.getInsights({ days: 20 }).catch(() => null),
  ]);

  const recentDates = (index.days || [])
    .map(d => d.date)
    .filter(d => d <= dateStr)
    .sort()
    .slice(-12);

  const recent = [];
  for (const d of recentDates) {
    const s = await tcHistory.getDaySummary(d);
    if (!s?.pointCount) continue;
    recent.push({
      date: d,
      open: s.open,
      close: s.close,
      min: s.min,
      minAt: s.minAt,
      max: s.max,
      maxAt: s.maxAt,
      range: s.range,
    });
  }

  let news = [];
  const archived = await newsArchive.getNewsForDay(dateStr).catch(() => null);
  if (archived?.items?.length) {
    news = compactNews(archived.items);
  } else if (dateStr === todayART()) {
    try {
      const { getNews } = require('./newsService');
      const live = await getNews();
      news = compactNews((live.items || []).filter(n => n.impact === 'muy_alto' || n.impact === 'alto' || (n.score || 0) >= 4));
    } catch { /* sin noticias */ }
  }

  return {
    date: dateStr,
    today: todaySummary,
    recentSessions: recent,
    hourlyPattern: insights?.bestWindows || [],
    daysAnalyzedPattern: insights?.daysAnalyzed || 0,
    news,
  };
}

function parseAnalysis(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { data = { todaySummary: raw }; }
  }
  const bias = String(data.todayBias || data.bias || 'lateral').toLowerCase();
  const allowed = new Set(['alcista', 'bajista', 'lateral']);
  return {
    todayBias: allowed.has(bias) ? bias : 'lateral',
    todaySummary: String(data.todaySummary || data.resumenHoy || '').slice(0, 1200),
    nextDays: {
      bias: allowed.has(String(data.nextDays?.bias || '').toLowerCase())
        ? String(data.nextDays.bias).toLowerCase()
        : 'lateral',
      horizon: String(data.nextDays?.horizon || '2 a 5 ruedas'),
      text: String(data.nextDays?.text || data.proximosDias || '').slice(0, 1200),
    },
    drivers: Array.isArray(data.drivers)
      ? data.drivers.slice(0, 6).map(d => ({
        factor: String(d.factor || d.name || '').slice(0, 80),
        effect: String(d.effect || '').slice(0, 20),
        note: String(d.note || '').slice(0, 240),
      }))
      : [],
    risks: Array.isArray(data.risks) ? data.risks.map(r => String(r).slice(0, 200)).slice(0, 5) : [],
    confidence: Math.max(0, Math.min(100, Number(data.confidence) || 0)),
    disclaimer: 'Escenario orientativo. No es una recomendación de compra/venta ni una predicción exacta.',
  };
}

async function callOpenAI(context) {
  const res = await axios.post(OPENAI_URL, {
    model: MODEL,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Sos un analista de tipo de cambio mayorista USD/ARS (rueda 10:00-15:00 ART).
Respondé SOLO JSON válido con esta forma:
{
  "todayBias": "alcista|bajista|lateral",
  "todaySummary": "2-4 oraciones sobre la rueda del día y el horario más relevante",
  "nextDays": { "bias": "alcista|bajista|lateral", "horizon": "2 a 5 ruedas", "text": "2-4 oraciones" },
  "drivers": [{ "factor": "cosecha|deuda|BCRA|noticias|estacionalidad|otro", "effect": "alcista|bajista|neutro", "note": "..." }],
  "risks": ["..."],
  "confidence": 0-100
}
Sesgo alcista = el peso se debilita (TC sube). Bajista = el peso se fortalece o el TC baja/se aplana.
${ARGENTINA_FX_CONTEXT}`,
      },
      {
        role: 'user',
        content: `Fecha a analizar: ${context.date}\nDatos de rueda, historial reciente y noticias:\n${JSON.stringify(context)}`,
      },
    ],
  }, {
    timeout: 45_000,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const content = res.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI no devolvió contenido');
  return parseAnalysis(content);
}

async function generateOutlook(dateStr = todayART(), { force = false } = {}) {
  if (!hasOpenAI()) {
    return { ok: false, error: 'Falta OPENAI_API_KEY', configured: false };
  }

  if (!force) {
    const existing = await getStored(dateStr);
    if (existing?.analysis) {
      return { ok: true, cached: true, ...existing };
    }
  }

  const context = await buildContext(dateStr);
  const analysis = await callOpenAI(context);
  const saved = await saveStored(dateStr, analysis);
  return { ok: true, cached: false, ...saved };
}

async function getOutlook(dateStr = todayART()) {
  const stored = await getStored(dateStr);
  if (stored?.analysis) {
    const score = await scoreOne(stored);
    return { ok: true, found: true, configured: hasOpenAI(), ...stored, score };
  }
  return { ok: true, found: false, configured: hasOpenAI(), date: dateStr, analysis: null };
}

const LATERAL_PCT = 0.15; // |var| < 0.15% = lateral

function classifyMove(from, to) {
  if (from == null || to == null || !(from > 0)) return null;
  const pct = +(((to - from) / from) * 100).toFixed(3);
  if (Math.abs(pct) < LATERAL_PCT) return { bias: 'lateral', pct };
  return { bias: pct > 0 ? 'alcista' : 'bajista', pct };
}

function verdict(predicted, actual) {
  if (!predicted || !actual) return 'pendiente';
  if (predicted === actual) return 'acierto';
  if (predicted === 'lateral' || actual === 'lateral') return 'parcial';
  return 'error';
}

async function sessionMap() {
  const index = await tcHistory.listDays();
  const dates = (index.days || []).map(d => d.date).sort();
  const map = {};
  for (const d of dates) {
    const s = await tcHistory.getDaySummary(d);
    if (s?.close != null && s?.open != null) {
      map[d] = { open: s.open, close: s.close };
    }
  }
  return { dates, map };
}

function tradingDaysAfter(dates, dateStr, count) {
  return dates.filter(d => d > dateStr).slice(0, count);
}

async function scoreOne(row, sessions = null) {
  const dateStr = row.date;
  const predictedToday = row.analysis?.todayBias;
  const predictedNext = row.analysis?.nextDays?.bias;
  const today = todayART();
  const { dates, map } = sessions || await sessionMap();
  const here = map[dateStr];

  let todayEval = { predicted: predictedToday, actual: null, verdict: 'pendiente', changePct: null };
  if (here && dateStr < today) {
    const move = classifyMove(here.open, here.close);
    todayEval = {
      predicted: predictedToday,
      actual: move?.bias || null,
      verdict: verdict(predictedToday, move?.bias),
      changePct: move?.pct ?? null,
    };
  } else if (here && dateStr === today) {
    const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const m = art.getUTCHours() * 60 + art.getUTCMinutes();
    if (m >= 15 * 60) {
      const move = classifyMove(here.open, here.close);
      todayEval = {
        predicted: predictedToday,
        actual: move?.bias || null,
        verdict: verdict(predictedToday, move?.bias),
        changePct: move?.pct ?? null,
      };
    }
  }

  const later = tradingDaysAfter(dates, dateStr, 3);
  let nextEval = { predicted: predictedNext, actual: null, verdict: 'pendiente', changePct: null, evaluatedDate: null };
  if (here && later.length >= 2) {
    const evalDate = later[Math.min(2, later.length - 1)];
    const laterClose = map[evalDate]?.close;
    const move = classifyMove(here.close, laterClose);
    nextEval = {
      predicted: predictedNext,
      actual: move?.bias || null,
      verdict: verdict(predictedNext, move?.bias),
      changePct: move?.pct ?? null,
      evaluatedDate: evalDate,
    };
  }

  return { today: todayEval, nextDays: nextEval };
}

function tally(rows) {
  const acc = { today: { acierto: 0, parcial: 0, error: 0, pendiente: 0 }, nextDays: { acierto: 0, parcial: 0, error: 0, pendiente: 0 } };
  for (const r of rows) {
    acc.today[r.score?.today?.verdict || 'pendiente']++;
    acc.nextDays[r.score?.nextDays?.verdict || 'pendiente']++;
  }
  const rate = (g) => {
    const done = g.acierto + g.parcial + g.error;
    return done ? +(((g.acierto + g.parcial * 0.5) / done) * 100).toFixed(0) : null;
  };
  return { ...acc, todayPct: rate(acc.today), nextDaysPct: rate(acc.nextDays) };
}

async function listStored() {
  if (SUPABASE_CONFIGURED) {
    try {
      const rows = await supabaseRequest(
        'get',
        `${SUPABASE_TABLE}?select=session_date,analysis,generated_at&order=session_date.desc`
      );
      return (rows || []).map(r => ({
        date: r.session_date,
        analysis: r.analysis,
        generatedAt: r.generated_at,
        storage: 'supabase',
      }));
    } catch { /* fallback */ }
  }
  const store = readFile();
  return Object.keys(store)
    .sort()
    .reverse()
    .map(date => ({ date, analysis: store[date].analysis, generatedAt: store[date].generatedAt, storage: 'local-file' }));
}

async function getOutlookHistory() {
  const rows = await listStored();
  const sessions = await sessionMap();
  const scored = [];
  for (const row of rows) {
    scored.push({
      date: row.date,
      generatedAt: row.generatedAt,
      todayBias: row.analysis?.todayBias || null,
      nextBias: row.analysis?.nextDays?.bias || null,
      confidence: row.analysis?.confidence ?? null,
      score: await scoreOne(row, sessions),
    });
  }
  return { ok: true, days: scored, stats: tally(scored) };
}

module.exports = {
  generateOutlook,
  getOutlook,
  getOutlookHistory,
  hasOpenAI,
  todayART,
};

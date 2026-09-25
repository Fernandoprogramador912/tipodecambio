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

/** Solo guardamos / listamos análisis desde esta fecha (inclusive). */
function outlookStartDate() {
  return process.env.TC_OUTLOOK_START_DATE || todayART();
}

function isOnOrAfterStart(dateStr) {
  return Boolean(dateStr && dateStr >= outlookStartDate());
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
        return unwrapStored(dateStr, rows[0].analysis, rows[0].generated_at, 'supabase');
      }
    } catch { /* fallback local */ }
  }
  const store = readFile();
  const row = store[dateStr];
  return row
    ? unwrapStored(dateStr, row.analysis, row.generatedAt, 'local-file')
    : null;
}

/**
 * Formato v2 en el jsonb `analysis`:
 * { _v:2, estimate, estimateGeneratedAt, report, reportGeneratedAt, reportKind }
 * Legacy: el blob completo se trata como estimación (para no perder aciertos).
 */
function unwrapStored(dateStr, rawAnalysis, generatedAt, storage) {
  const a = rawAnalysis;
  if (a && a._v === 2) {
    return {
      date: dateStr,
      estimate: a.estimate || null,
      estimateGeneratedAt: a.estimateGeneratedAt || null,
      analysis: a.report || null, // "análisis" de rueda/cierre
      analysisGeneratedAt: a.reportGeneratedAt || null,
      reportKind: a.reportKind || null,
      generatedAt: generatedAt || a.reportGeneratedAt || a.estimateGeneratedAt || null,
      storage,
      _payload: a,
    };
  }
  // Legacy → era una sola pieza; la usamos como estimación para scoring
  return {
    date: dateStr,
    estimate: a || null,
    estimateGeneratedAt: generatedAt || null,
    analysis: null,
    analysisGeneratedAt: null,
    reportKind: null,
    generatedAt: generatedAt || null,
    storage,
    _payload: null,
  };
}

function wrapPayload(existingUnwrapped, { estimate, estimateGeneratedAt, report, reportGeneratedAt, reportKind }) {
  const prev = existingUnwrapped?._payload && existingUnwrapped._payload._v === 2
    ? existingUnwrapped._payload
    : {
      _v: 2,
      estimate: existingUnwrapped?.estimate || null,
      estimateGeneratedAt: existingUnwrapped?.estimateGeneratedAt || null,
      report: existingUnwrapped?.analysis || null,
      reportGeneratedAt: existingUnwrapped?.analysisGeneratedAt || null,
      reportKind: existingUnwrapped?.reportKind || null,
    };

  return {
    _v: 2,
    estimate: estimate !== undefined ? estimate : prev.estimate,
    estimateGeneratedAt: estimateGeneratedAt !== undefined ? estimateGeneratedAt : prev.estimateGeneratedAt,
    report: report !== undefined ? report : prev.report,
    reportGeneratedAt: reportGeneratedAt !== undefined ? reportGeneratedAt : prev.reportGeneratedAt,
    reportKind: reportKind !== undefined ? reportKind : prev.reportKind,
  };
}

async function saveStoredParts(dateStr, parts) {
  if (!isOnOrAfterStart(dateStr)) {
    return { date: dateStr, storage: 'skipped-before-start', ...parts };
  }
  const existing = await getStored(dateStr);
  const payload = wrapPayload(existing, parts);
  const generatedAt = new Date().toISOString();

  if (SUPABASE_CONFIGURED) {
    try {
      await supabaseRequest('post', `${SUPABASE_TABLE}?on_conflict=session_date`, {
        session_date: dateStr,
        analysis: payload,
        generated_at: generatedAt,
      }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
      return unwrapStored(dateStr, payload, generatedAt, 'supabase');
    } catch (err) {
      console.warn('[tc-outlook] Supabase falló, usando archivo local:', err.message);
    }
  }

  const store = readFile();
  store[dateStr] = { analysis: payload, generatedAt };
  const keys = Object.keys(store).sort().reverse();
  if (keys.length > 90) keys.slice(90).forEach(k => delete store[k]);
  writeFile(store);
  return unwrapStored(dateStr, payload, generatedAt, 'local-file');
}

/** @deprecated use saveStoredParts — mantiene compat para llamadas viejas */
async function saveStored(dateStr, analysis) {
  const kind = analysis?.kind === 'close' || analysis?.kind === 'intraday' ? analysis.kind : 'estimate';
  const at = new Date().toISOString();
  if (kind === 'estimate') {
    return saveStoredParts(dateStr, { estimate: analysis, estimateGeneratedAt: at });
  }
  return saveStoredParts(dateStr, {
    report: analysis,
    reportGeneratedAt: at,
    reportKind: kind,
  });
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

/** Hora ART actual como { hh, mm, minutesSinceMidnight, isoTime }. */
function nowARTClock() {
  const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const hh = art.getUTCHours();
  const mm = art.getUTCMinutes();
  return {
    hh,
    mm,
    minutes: hh * 60 + mm,
    timeLabel: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    date: art.toISOString().slice(0, 10),
  };
}

/**
 * Fase de la rueda para la fecha pedida.
 * - historical: día ya cerrado en el pasado
 * - pre_open / in_progress / closed: día de hoy según horario ART
 */
function sessionPhaseFor(dateStr) {
  const clock = nowARTClock();
  if (dateStr < clock.date) {
    return { phase: 'historical', timeLabel: clock.timeLabel, date: dateStr };
  }
  if (dateStr > clock.date) {
    return { phase: 'future', timeLabel: clock.timeLabel, date: dateStr };
  }
  if (clock.minutes < 10 * 60) {
    return { phase: 'pre_open', timeLabel: clock.timeLabel, date: dateStr };
  }
  if (clock.minutes >= 15 * 60) {
    return { phase: 'closed', timeLabel: clock.timeLabel, date: dateStr };
  }
  return { phase: 'in_progress', timeLabel: clock.timeLabel, date: dateStr };
}

function reshapeTodayForPrompt(todaySummary, phaseInfo) {
  if (!todaySummary || !todaySummary.pointCount) {
    return {
      ...todaySummary,
      sessionPhase: phaseInfo.phase,
      nowART: phaseInfo.timeLabel,
      note: 'Todavía no hay puntos de la rueda (o rueda aún no arrancó).',
    };
  }

  const base = {
    date: todaySummary.date,
    open: todaySummary.open,
    min: todaySummary.min,
    minAt: todaySummary.minAt,
    max: todaySummary.max,
    maxAt: todaySummary.maxAt,
    avg: todaySummary.avg,
    range: todaySummary.range,
    pointCount: todaySummary.pointCount,
    cierreAnterior: todaySummary.cierreAnterior || null,
    sessionPhase: phaseInfo.phase,
    nowART: phaseInfo.timeLabel,
  };

  if (phaseInfo.phase === 'in_progress' || phaseInfo.phase === 'pre_open') {
    return {
      ...base,
      lastPriceSoFar: todaySummary.close,
      lastPriceAt: 'último dato disponible hasta ahora (NO es el cierre de la rueda)',
      note: `La rueda sigue ABIERTA (ahora ${phaseInfo.timeLabel} ART). open/min/max/lastPriceSoFar son parciales. No digas que el día “se mantuvo” ni “cerró”: escribí escenario esperado para el resto de la rueda.`,
    };
  }

  return {
    ...base,
    close: todaySummary.close,
    note: phaseInfo.phase === 'closed'
      ? `Rueda de hoy ya cerrada (ahora ${phaseInfo.timeLabel} ART). Podés resumir en pasado.`
      : 'Día histórico cerrado. Resumí en pasado.',
  };
}

async function buildContext(dateStr) {
  const phaseInfo = sessionPhaseFor(dateStr);
  const [index, todaySummary, insights] = await Promise.all([
    tcHistory.listDays(),
    tcHistory.getDaySummary(dateStr),
    tcHistory.getInsights({ days: 20, until: dateStr }).catch(() => null),
  ]);

  const recentDates = (index.days || [])
    .map(d => d.date)
    .filter(d => d < dateStr) // no mezclar el día parcial como “sesión completa”
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
    sessionPhase: phaseInfo.phase,
    nowART: phaseInfo.timeLabel,
    today: reshapeTodayForPrompt(todaySummary, phaseInfo),
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
    scenarios: Array.isArray(data.scenarios)
      ? data.scenarios.slice(0, 6).map(s => {
        const rawBias = String(s.thenBias || s.effect || '').toLowerCase();
        const thenRaw = String(s.thenText || s.then || s.note || '');
        return {
          if: String(s.if || s.si || s.condition || '').slice(0, 220),
          thenBias: allowed.has(rawBias) ? rawBias : 'lateral',
          then: thenRaw.slice(0, 320),
        };
      }).filter(s => s.if)
      : [],
    confidence: Math.max(0, Math.min(100, Number(data.confidence) || 0)),
    kind: data.kind === 'close' ? 'close' : (data.kind === 'intraday' ? 'intraday' : undefined),
    source: data.source ? String(data.source).slice(0, 20) : undefined,
    disclaimer: 'Escenario orientativo. El sesgo base vale si no cambia el contexto; cada condicional indica qué pasaría si ocurre ese evento. No es recomendación de compra/venta.',
  };
}

async function callOpenAI(context, { correctionHint = null, purpose = null } = {}) {
  const phase = context.sessionPhase || 'historical';
  const intent = purpose || context.purpose || (
    phase === 'pre_open' ? 'estimate' : (phase === 'closed' || phase === 'historical' ? 'close_analysis' : 'intraday_analysis')
  );
  const isEstimate = intent === 'estimate';
  const isClose = intent === 'close_analysis' || phase === 'closed' || phase === 'historical';

  const todaySummaryHint = isEstimate
    ? `todaySummary: 2-4 oraciones de ESTIMACIÓN PRE-RUEDA (ahora ${context.nowART} ART). Futuro/condicional: qué se espera en la rueda de hoy. Prohibido pasado de cierre.`
    : isClose
      ? `todaySummary: 2-4 oraciones en PASADO resumiendo la rueda del día.`
      : `todaySummary: 2-4 oraciones sobre qué está pasando ahora y el escenario para el resto de la rueda (ahora ${context.nowART} ART).`;

  const roleLabel = isEstimate
    ? 'Estimás el sesgo del día ANTES de que abra la rueda (no es un balance).'
    : isClose
      ? 'Hacés el análisis de cierre de la rueda mayorista.'
      : 'Analizás la rueda en curso (no confundir con la estimación pre-apertura).';

  const messages = [
    {
      role: 'system',
      content: `Sos un analista de tipo de cambio mayorista USD/ARS (rueda 10:00-15:00 ART).
${roleLabel}
Respondé SOLO JSON válido con esta forma:
{
  "todayBias": "alcista|bajista|lateral",
  "todaySummary": "texto según las reglas de tiempo verbal",
  "nextDays": { "bias": "alcista|bajista|lateral", "horizon": "2 a 5 ruedas", "text": "2-4 oraciones. El sesgo base asume que no hay sorpresa." },
  "drivers": [{ "factor": "cosecha|deuda|BCRA|noticias|elecciones|estacionalidad|otro", "effect": "alcista|bajista|neutro", "note": "..." }],
  "scenarios": [
    { "if": "evento concreto", "thenBias": "bajista|alcista|lateral", "then": "qué haría el mayorista y por qué" },
    { "if": "el evento contrario", "thenBias": "alcista|bajista|lateral", "then": "qué haría el mayorista" }
  ],
  "risks": ["..."],
  "confidence": 0-100
}
Sesgo alcista = el peso se debilita (TC sube). Bajista = el peso se fortalece o el TC baja/se aplana.
El campo scenarios es OBLIGATORIO (mínimo 2, máximo 4).
${todaySummaryHint}
Si aparece lastPriceSoFar, NO es cierre oficial.
${ARGENTINA_FX_CONTEXT}`,
    },
    {
      role: 'user',
      content: `Fecha: ${context.date}
Hora ART: ${context.nowART || '—'}
Fase: ${phase}
Propósito: ${intent}
${isEstimate ? 'IMPORTANTE: estimación pre-rueda para decidir. Mediremos el acierto al cierre.' : ''}
Datos:
${JSON.stringify(context)}`,
    },
  ];

  if (correctionHint) {
    messages.push({ role: 'user', content: correctionHint });
  }

  const res = await axios.post(OPENAI_URL, {
    model: MODEL,
    temperature: isEstimate ? 0.25 : 0.3,
    response_format: { type: 'json_object' },
    messages,
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

/** Detecta redactado de “día cerrado” cuando la rueda todavía está abierta. */
function looksLikeClosedDayWording(text = '') {
  const t = String(text).toLowerCase();
  if (!t) return false;
  const patterns = [
    /\bse mantuvo\b/,
    /\bse mantuvieron\b/,
    /\bcerr[oó]\b/,
    /\bcierre (de la|del) (d[ií]a|rueda)\b/,
    /\bdurante el d[ií]a\b/,
    /\ba lo largo del d[ií]a\b/,
    /\bsin variaciones significativas durante\b/,
    /\bla rueda (del|de hoy).{0,40}(fue|termin[oó]|finaliz[oó])\b/,
    /\bel tipo de cambio.{0,30}(fue|qued[oó]|termin[oó])\b/,
  ];
  return patterns.some(re => re.test(t));
}

/** Estimación pre-rueda: 08:00–09:55 ART. Análisis de rueda: 10:00–15:00. Cierre auto 15:30. */
const ESTIMATE_START_MIN = 8 * 60;
const ESTIMATE_END_MIN = 9 * 60 + 55; // inclusive window until 09:55
const ANALYSIS_START_MIN = 10 * 60;
const ANALYSIS_END_MIN = 15 * 60; // exclusive: hasta 14:59
const MANUAL_THROTTLE_MS = Number(process.env.TC_OUTLOOK_MANUAL_THROTTLE_MS) || 30 * 60 * 1000;

function getRunPolicy(dateStr = todayART()) {
  const clock = nowARTClock();
  const isToday = dateStr === clock.date;
  const afterClose = isToday && clock.minutes >= 15 * 60;

  let estimateAllowed = false;
  let estimateReason = null;
  let analysisAllowed = false;
  let analysisReason = null;

  if (!isToday) {
    estimateReason = 'Solo se puede generar la estimación del día de hoy.';
    analysisReason = 'Solo se puede generar el análisis del día de hoy.';
  } else {
    if (clock.minutes < ESTIMATE_START_MIN) {
      estimateReason = 'La estimación manual está disponible de 08:00 a 09:55 ART (antes de la rueda).';
    } else if (clock.minutes <= ESTIMATE_END_MIN) {
      estimateAllowed = true;
    } else {
      estimateReason = 'La ventana de estimación pre-rueda es 08:00–09:55 ART. Después solo queda el análisis de rueda/cierre.';
    }

    if (clock.minutes < ANALYSIS_START_MIN) {
      analysisReason = 'El análisis de rueda está disponible de 10:00 a 15:00 ART. Antes usá la Estimación (08:00–09:55).';
    } else if (clock.minutes < ANALYSIS_END_MIN) {
      analysisAllowed = true;
    } else {
      analysisReason = afterClose
        ? 'La rueda ya cerró. El análisis de cierre se genera solo a las 15:30 ART.'
        : 'La ventana de análisis de rueda es 10:00–15:00 ART.';
    }
  }

  // Compat: manualAllowed = estimate (lo que mide aciertos)
  return {
    date: dateStr,
    nowART: clock.timeLabel,
    isToday,
    estimateAllowed,
    estimateReason,
    estimateWindow: '08:00–09:55 ART',
    estimateCron: '09:00 ART',
    analysisAllowed,
    analysisReason,
    analysisWindow: '10:00–15:00 ART',
    closeCron: '15:30 ART',
    manualAllowed: estimateAllowed,
    manualReason: estimateReason,
    manualWindow: '08:00–09:55 ART',
    throttleMinutes: Math.round(MANUAL_THROTTLE_MS / 60000),
  };
}

/**
 * @param {string} dateStr
 * @param {{ force?: boolean, kind?: 'estimate'|'intraday'|'close', source?: 'manual'|'cron'|'system' }} opts
 */
async function generateOutlook(dateStr = todayART(), opts = {}) {
  const force = Boolean(opts.force);
  const source = opts.source || 'manual';
  let kind = opts.kind;
  if (kind !== 'estimate' && kind !== 'close' && kind !== 'intraday') {
    kind = 'estimate';
  }

  if (!hasOpenAI()) {
    return { ok: false, error: 'Falta OPENAI_API_KEY', configured: false };
  }

  const policy = getRunPolicy(dateStr);
  const isEstimate = kind === 'estimate';

  if (source === 'manual') {
    const allowed = isEstimate ? policy.estimateAllowed : policy.analysisAllowed;
    const reason = isEstimate ? policy.estimateReason : policy.analysisReason;
    if (!allowed) {
      return { ok: false, error: reason, configured: true, runPolicy: policy, view: isEstimate ? 'estimate' : 'analysis' };
    }

    if (force) {
      const existing = await getStored(dateStr);
      const stamp = isEstimate ? existing?.estimateGeneratedAt : existing?.analysisGeneratedAt;
      if (stamp) {
        const age = Date.now() - new Date(stamp).getTime();
        if (Number.isFinite(age) && age >= 0 && age < MANUAL_THROTTLE_MS) {
          const waitMin = Math.ceil((MANUAL_THROTTLE_MS - age) / 60000);
          const content = isEstimate ? existing.estimate : existing.analysis;
          return {
            ok: false,
            error: `Ya hay un ${isEstimate ? 'estimado' : 'análisis'} reciente. Podés actualizar en ~${waitMin} min (máx. 1 cada ${policy.throttleMinutes} min).`,
            configured: true,
            runPolicy: policy,
            cached: true,
            found: Boolean(content),
            date: existing.date,
            analysis: content,
            estimate: existing.estimate,
            generatedAt: stamp,
            kind: isEstimate ? 'estimate' : (existing.reportKind || kind),
            view: isEstimate ? 'estimate' : 'analysis',
            storage: existing.storage,
          };
        }
      }
    }
  }

  if (!force) {
    const existing = await getStored(dateStr);
    const content = isEstimate ? existing?.estimate : existing?.analysis;
    if (content) {
      return {
        ok: true,
        cached: true,
        date: dateStr,
        analysis: content,
        estimate: existing.estimate,
        generatedAt: isEstimate ? existing.estimateGeneratedAt : existing.analysisGeneratedAt,
        kind: isEstimate ? 'estimate' : (existing.reportKind || kind),
        view: isEstimate ? 'estimate' : 'analysis',
        storage: existing.storage,
        runPolicy: policy,
      };
    }
  }

  const context = await buildContext(dateStr);
  if (kind === 'estimate') {
    context.sessionPhase = 'pre_open';
    context.purpose = 'estimate';
    if (context.today && typeof context.today === 'object') {
      context.today.sessionPhase = 'pre_open';
      context.today.note = `ESTIMACIÓN PRE-RUEDA (ahora ${context.nowART} ART). La rueda todavía NO empezó. Escribí qué se espera para la rueda de hoy (10:00–15:00). Prohibido hablar en pasado como si el día hubiera cerrado.`;
      delete context.today.lastPriceSoFar;
      delete context.today.lastPriceAt;
      delete context.today.close;
    }
  } else if (kind === 'close') {
    context.sessionPhase = 'closed';
    context.purpose = 'close_analysis';
    if (context.today && typeof context.today === 'object') {
      context.today.sessionPhase = 'closed';
      context.today.note = `ANÁLISIS DE CIERRE (${context.nowART || '15:30'} ART). Resumí en pasado lo ocurrido en la rueda completa.`;
      if (context.today.lastPriceSoFar != null && context.today.close == null) {
        context.today.close = context.today.lastPriceSoFar;
        delete context.today.lastPriceSoFar;
        delete context.today.lastPriceAt;
      }
    }
  } else {
    context.purpose = 'intraday_analysis';
    if (context.today && typeof context.today === 'object') {
      context.today.note = `ANÁLISIS DE RUEDA EN CURSO (ahora ${context.nowART} ART). Describí qué está pasando hasta ahora y el escenario para el resto de la rueda. No es la estimación pre-apertura.`;
    }
  }

  let analysis = await callOpenAI(context, { purpose: context.purpose });

  if ((kind === 'estimate' || kind === 'intraday') && looksLikeClosedDayWording(analysis.todaySummary)) {
    console.warn('[tc-outlook] Texto en pasado indebido; reintentando…');
    analysis = await callOpenAI(context, {
      purpose: context.purpose,
      correctionHint: kind === 'estimate'
        ? `CORRECCIÓN: esto es una ESTIMACIÓN PRE-RUEDA. Reescribí en futuro/condicional ("se espera", "el sesgo es"). Prohibido "se mantuvo" / "durante el día".`
        : `CORRECCIÓN: la rueda sigue abierta. Escribí escenario hacia adelante, no balance de cierre.`,
    });
    if (looksLikeClosedDayWording(analysis.todaySummary)) {
      const prefix = kind === 'estimate'
        ? `Estimación pre-rueda (${context.nowART} ART): `
        : `A esta hora (${context.nowART} ART) la rueda sigue abierta. `;
      analysis.todaySummary = `${prefix}${analysis.todaySummary}`.replace(/\s+/g, ' ').slice(0, 1200);
    }
  }

  analysis.kind = kind;
  analysis.source = source;
  const at = new Date().toISOString();

  let saved;
  if (kind === 'estimate') {
    saved = await saveStoredParts(dateStr, { estimate: analysis, estimateGeneratedAt: at });
  } else {
    saved = await saveStoredParts(dateStr, {
      report: analysis,
      reportGeneratedAt: at,
      reportKind: kind,
    });
  }

  return {
    ok: true,
    cached: false,
    date: dateStr,
    analysis, // contenido recién generado (vista activa)
    estimate: saved.estimate,
    generatedAt: at,
    kind,
    view: kind === 'estimate' ? 'estimate' : 'analysis',
    storage: saved.storage,
    sessionPhase: context.sessionPhase,
    nowART: context.nowART,
    runPolicy: policy,
  };
}

async function getOutlook(dateStr = todayART(), { view = 'estimate' } = {}) {
  const policy = getRunPolicy(dateStr);
  const stored = await getStored(dateStr);
  const wantEstimate = view !== 'analysis';

  if (!stored) {
    return {
      ok: true,
      found: false,
      configured: hasOpenAI(),
      date: dateStr,
      analysis: null,
      estimate: null,
      view: wantEstimate ? 'estimate' : 'analysis',
      runPolicy: policy,
    };
  }

  const content = wantEstimate ? stored.estimate : stored.analysis;
  const generatedAt = wantEstimate ? stored.estimateGeneratedAt : stored.analysisGeneratedAt;

  // Scoring es caro (recorre historial TC). Solo para vista estimación.
  let score = null;
  if (wantEstimate && stored.estimate) {
    score = await scoreOne({ date: dateStr, analysis: stored.estimate });
  }

  return {
    ok: true,
    found: Boolean(content),
    configured: hasOpenAI(),
    date: dateStr,
    analysis: content,
    estimate: stored.estimate,
    report: stored.analysis,
    reportKind: stored.reportKind,
    generatedAt,
    kind: wantEstimate ? 'estimate' : (stored.reportKind || 'analysis'),
    view: wantEstimate ? 'estimate' : 'analysis',
    storage: stored.storage,
    score,
    runPolicy: policy,
  };
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

let sessionMapCache = { at: 0, value: null };
const SESSION_MAP_TTL_MS = 60_000;

async function sessionMap() {
  const now = Date.now();
  if (sessionMapCache.value && now - sessionMapCache.at < SESSION_MAP_TTL_MS) {
    return sessionMapCache.value;
  }
  const index = await tcHistory.listDays();
  const dates = (index.days || []).map(d => d.date).sort();
  const map = {};
  // Solo open/close: usamos getDay (más liviano) + compute vía summary, en paralelo por lotes
  const batchSize = 8;
  for (let i = 0; i < dates.length; i += batchSize) {
    const slice = dates.slice(i, i + batchSize);
    await Promise.all(slice.map(async (d) => {
      const s = await tcHistory.getDaySummary(d);
      if (s?.close != null && s?.open != null) {
        map[d] = { open: s.open, close: s.close };
      }
    }));
  }
  const value = { dates, map };
  sessionMapCache = { at: now, value };
  return value;
}

/** Scoring liviano: solo pide los días necesarios (el de la fila + 2-3 posteriores). */
async function sessionsForScore(dateStr) {
  const index = await tcHistory.listDays();
  const dates = (index.days || []).map(d => d.date).sort();
  const later = tradingDaysAfter(dates, dateStr, 3);
  const need = [...new Set([dateStr, ...later])];
  const map = {};
  await Promise.all(need.map(async (d) => {
    const s = await tcHistory.getDaySummary(d);
    if (s?.close != null && s?.open != null) {
      map[d] = { open: s.open, close: s.close };
    }
  }));
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
  const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const minutesNow = art.getUTCHours() * 60 + art.getUTCMinutes();

  // Hoy antes del cierre: no hace falta cargar historial TC
  if (dateStr === today && minutesNow < 15 * 60) {
    return {
      today: { predicted: predictedToday, actual: null, verdict: 'pendiente', changePct: null },
      nextDays: { predicted: predictedNext, actual: null, verdict: 'pendiente', changePct: null, evaluatedDate: null },
    };
  }

  const { dates, map } = sessions || await sessionsForScore(dateStr);
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
  } else if (here && dateStr === today && minutesNow >= 15 * 60) {
    const move = classifyMove(here.open, here.close);
    todayEval = {
      predicted: predictedToday,
      actual: move?.bias || null,
      verdict: verdict(predictedToday, move?.bias),
      changePct: move?.pct ?? null,
    };
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
  const acc = {
    today: { acierto: 0, parcial: 0, error: 0, pendiente: 0 },
    nextDays: { acierto: 0, parcial: 0, error: 0, pendiente: 0 },
  };
  for (const r of rows) {
    acc.today[r.score?.today?.verdict || 'pendiente']++;
    acc.nextDays[r.score?.nextDays?.verdict || 'pendiente']++;
  }
  const rate = (g) => {
    const done = g.acierto + g.parcial + g.error;
    return done ? +(((g.acierto + g.parcial * 0.5) / done) * 100).toFixed(0) : null;
  };
  const todayDone = acc.today.acierto + acc.today.parcial + acc.today.error;
  const nextDone = acc.nextDays.acierto + acc.nextDays.parcial + acc.nextDays.error;
  return {
    ...acc,
    todayPct: rate(acc.today),
    nextDaysPct: rate(acc.nextDays),
    todayEvaluated: todayDone,
    nextDaysEvaluated: nextDone,
    todayPending: acc.today.pendiente,
    nextDaysPending: acc.nextDays.pendiente,
    total: rows.length,
  };
}

async function listStored() {
  const start = outlookStartDate();
  if (SUPABASE_CONFIGURED) {
    try {
      const rows = await supabaseRequest(
        'get',
        `${SUPABASE_TABLE}?session_date=gte.${start}&select=session_date,analysis,generated_at&order=session_date.desc`
      );
      if (Array.isArray(rows) && rows.length) {
        return rows.map(r => unwrapStored(r.session_date, r.analysis, r.generated_at, 'supabase'));
      }
    } catch { /* fallback local */ }
  }
  const store = readFile();
  return Object.keys(store)
    .filter(isOnOrAfterStart)
    .sort()
    .reverse()
    .map(date => unwrapStored(date, store[date].analysis, store[date].generatedAt, 'local-file'));
}

async function getOutlookHistory() {
  const rows = (await listStored()).filter(r => r.estimate);
  const index = await tcHistory.listDays();
  const dates = (index.days || []).map(d => d.date).sort();
  const need = new Set();
  for (const row of rows) {
    need.add(row.date);
    tradingDaysAfter(dates, row.date, 3).forEach(d => need.add(d));
  }
  const map = {};
  await Promise.all([...need].map(async (d) => {
    const s = await tcHistory.getDaySummary(d);
    if (s?.close != null && s?.open != null) {
      map[d] = { open: s.open, close: s.close };
    }
  }));
  const sessions = { dates, map };

  const scored = [];
  for (const row of rows) {
    const score = await scoreOne({ date: row.date, analysis: row.estimate }, sessions);
    scored.push({
      date: row.date,
      generatedAt: row.estimateGeneratedAt,
      kind: 'estimate',
      todayBias: row.estimate?.todayBias || null,
      todaySummary: row.estimate?.todaySummary || null,
      nextBias: row.estimate?.nextDays?.bias || null,
      nextDaysText: row.estimate?.nextDays?.text || null,
      nextHorizon: row.estimate?.nextDays?.horizon || null,
      confidence: row.estimate?.confidence ?? null,
      hasAnalysis: Boolean(row.analysis),
      score,
    });
  }
  return { ok: true, days: scored, stats: tally(scored), startDate: outlookStartDate() };
}

module.exports = {
  generateOutlook,
  getOutlook,
  getOutlookHistory,
  getRunPolicy,
  hasOpenAI,
  todayART,
};

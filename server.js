require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { getRates }           = require('./src/services/exchangeService');
const { getNews }            = require('./src/services/newsService');
const { calculateProjection }                         = require('./src/services/projectionService');
const {
  saveProjection,
  recordClose,
  getHistory,
  getTodayProjection,
  isAfterDailyProjectionTime,
  SUPABASE_ENABLED,
} = require('./src/services/projectionHistoryService');
const { getFutures, ENABLED: FUTURES_ENABLED } = require('./src/providers/futuresProvider');
const a3MatrizWs = require('./src/providers/a3MatrizWsProvider');
const wsProvider = require('./src/providers/wsProvider');
const tcIntradayHistory = require('./src/services/tcIntradayHistoryService');
const { getCierreAnterior } = require('./src/services/mayoristaCierreStore');
const newsArchive = require('./src/services/newsArchiveService');
const tcOutlook = require('./src/services/tcOutlookService');
const tcDayMemory = require('./src/services/tcDayMemoryService');
const tcTiming = require('./src/services/tcTimingService');
const { startTcIntradayRecorder, pulseFromA3 } = require('./src/services/tcIntradayRecorderService');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function buildProjectionSnapshot(source = 'manual') {
  const [rates, futures, news] = await Promise.all([
    getRates(),
    getFutures(),
    getNews().catch(err => ({ items: [], error: err.message })),
  ]);

  const spot = rates.usd?.venta;
  if (!spot) {
    const err = new Error('Sin cotización spot');
    err.statusCode = 503;
    throw err;
  }

  const inputs = {
    source,
    capturedAt: new Date().toISOString(),
    rates: {
      usd: rates.usd || null,
      eur: rates.eur || null,
      mep: rates.mep || null,
      spreadMepMayorista: rates.spreadMepMayorista || null,
      forexGlobal: rates.forexGlobal || null,
    },
    futures: {
      enabled: futures.enabled,
      contracts: (futures.contracts || []).slice(0, 10),
    },
    news: {
      items: (news.items || []).slice(0, 12),
      error: news.error || null,
    },
  };

  const projection = calculateProjection(spot, futures.contracts || [], {
    forexGlobal: rates.forexGlobal,
    newsItems: news.items || [],
  });

  return { projection, inputs };
}

function validateJobSecret(req) {
  const expected = process.env.PROJECTION_JOB_SECRET;
  if (!expected) return process.env.NODE_ENV !== 'production';
  return req.get('x-job-secret') === expected;
}

// --- API: tipos de cambio ---
app.get('/api/fx', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (req.query.reconnect === '1') {
      a3MatrizWs.forceReconnect();
      wsProvider.forceReconnect();
      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    const rates = await getRates();
    const a3Age = a3MatrizWs.getLastMessageAgeMs();
    res.json({
      ok: true,
      data: rates,
      fetchedAt: new Date().toISOString(),
      stream: {
        a3Connected: a3MatrizWs.isConnected(),
        a3LastMessageSec: a3Age != null ? Math.round(a3Age / 1000) : null,
      },
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// --- API: proyección intradiaria ---
app.get('/api/projection', async (req, res) => {
  try {
    const saved = await getTodayProjection();
    if (saved?.projection) {
      return res.json({
        ok: true,
        data: saved.projection,
        stored: true,
        locked: true,
        storage: SUPABASE_ENABLED ? 'supabase' : 'local-file',
        savedAt: saved.savedAt || saved.projection.generatedAt || null,
      });
    }

    // Antes de las 9:00 ART: vista previa orientativa (no es la proyección oficial del día).
    if (!isAfterDailyProjectionTime()) {
      const { projection } = await buildProjectionSnapshot('preview');
      return res.json({
        ok: true,
        data: projection,
        stored: false,
        locked: false,
        preview: true,
      });
    }

    // Después de las 9:00: no recalcular con TC en vivo; esperar el job diario.
    const history = await getHistory().catch(() => ({ records: [] }));
    const lastRecord = history.records?.[0] || null;
    return res.json({
      ok: true,
      stored: false,
      locked: false,
      pending: true,
      data: null,
      message: 'La proyección oficial del día se registra a las 9:00 (ART). Todavía no está disponible para hoy.',
      lastSavedDate: lastRecord?.date || null,
      hint: lastRecord
        ? `Última proyección guardada: ${lastRecord.date}. Si ya pasaron las 9:00, ejecutá el workflow "Daily projection" en GitHub Actions.`
        : 'Aún no hay proyecciones guardadas. Configurá los secrets APP_URL y PROJECTION_JOB_SECRET y ejecutá "Daily projection" en GitHub Actions.',
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// --- API: guardar proyección del día ---
app.post('/api/projection/record', async (req, res) => {
  try {
    const { projection, inputs } = await buildProjectionSnapshot('manual-record');
    const result = await saveProjection(projection, inputs);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// --- API: job diario 9:00 ART (GitHub Actions / cron externo) ---
app.post('/api/projection/daily-run', async (req, res) => {
  if (!validateJobSecret(req)) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }

  try {
    const { projection, inputs } = await buildProjectionSnapshot('daily-9am');
    const result = await saveProjection(projection, inputs);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// --- API: registrar precio de cierre real ---
app.post('/api/projection/close', async (req, res) => {
  try {
    const { closePrice } = req.body;
    if (!closePrice || isNaN(closePrice)) {
      return res.status(400).json({ ok: false, error: 'closePrice requerido' });
    }
    const result = await recordClose(Number(closePrice));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- API: historial intradiario USD/ARS por día ---
/** Keep-alive / cron: persiste un tick si hay rueda (10:00–15:00 ART). */
app.get('/api/tc-history/heartbeat', async (req, res) => {
  try {
    const pulse = pulseFromA3();
    res.json({ ok: true, ...pulse, ts: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/tc-history', async (req, res) => {
  try {
    const index = await tcIntradayHistory.listDays();
    res.json({ ok: true, ...index });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Insights: estadísticas históricas por franja horaria (para mejor horario de cierre). */
app.get('/api/tc-history/insights', async (req, res) => {
  try {
    const days = req.query.days ? Number(req.query.days) : 20;
    const until = typeof req.query.until === 'string' ? req.query.until : undefined;
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return res.status(400).json({ ok: false, error: 'until inválido (YYYY-MM-DD)' });
    }
    const result = await tcIntradayHistory.getInsights({ days, until });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/tc-history/:date', async (req, res) => {
  try {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'Fecha inválida (YYYY-MM-DD)' });
    }
    const day = await tcIntradayHistory.getDay(date);
    res.json({ ok: true, ...day });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Resumen estadístico de un día (min/max/rango/horarios + cierre anterior). */
app.get('/api/tc-history/:date/summary', async (req, res) => {
  try {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'Fecha inválida (YYYY-MM-DD)' });
    }
    const summary = await tcIntradayHistory.getDaySummary(date);
    res.json({ ok: true, ...summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tc-history/point', async (req, res) => {
  try {
    const venta = Number(req.body?.venta);
    if (!Number.isFinite(venta)) {
      return res.status(400).json({ ok: false, error: 'venta requerida' });
    }
    const result = await tcIntradayHistory.addPoint(
      venta,
      Number(req.body?.compra) || venta,
      req.body?.ts
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tc-history/sync', async (req, res) => {
  try {
    const result = await tcIntradayHistory.syncDays(req.body?.days || {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- API: historial de proyecciones ---
app.get('/api/projection/history', async (req, res) => {
  try {
    const history = await getHistory();
    res.json({ ok: true, ...history });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- API: noticias ---
app.get('/api/news', async (req, res) => {
  try {
    const news = await getNews();
    res.json({ ok: true, ...news, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// --- API: archivo de noticias por día ---
app.get('/api/news-archive', async (req, res) => {
  try {
    const days = await newsArchive.listArchivedDays();
    res.json({ ok: true, days });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/news-archive/:date', async (req, res) => {
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'Fecha inválida (YYYY-MM-DD)' });
    }
    const day = await newsArchive.getNewsForDay(date);
    if (!day) return res.json({ ok: true, date, items: [], found: false });
    res.json({ ok: true, found: true, ...day });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Archiva noticias del día (llamada manual o por cron externo). */
app.post('/api/news-archive/today', async (req, res) => {
  try {
    const news = await getNews();
    const result = await newsArchive.archiveToday(news.items || []);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- API: análisis de escenario TC (OpenAI) ---
app.get('/api/tc-outlook/history', async (req, res) => {
  try {
    const result = await tcOutlook.getOutlookHistory();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/tc-outlook', async (req, res) => {
  try {
    const date = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : tcOutlook.todayART();
    const view = req.query.view === 'analysis' ? 'analysis' : 'estimate';
    const result = await tcOutlook.getOutlook(date, { view });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tc-outlook/run', async (req, res) => {
  try {
    const date = req.body?.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
      ? req.body.date
      : tcOutlook.todayART();
    const force = Boolean(req.body?.force);
    const source = req.body?.source === 'cron' ? 'cron' : 'manual';
    let kind = req.body?.kind;
    if (kind !== 'estimate' && kind !== 'close' && kind !== 'intraday') {
      kind = 'estimate';
    }
    const result = await tcOutlook.generateOutlook(date, { force, source, kind });
    const status = result.ok ? 200 : 400;
    res.status(status).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Job externo (GitHub Actions): estimación pre-rueda ~9:00 ART */
app.post('/api/tc-outlook/estimate-run', async (req, res) => {
  try {
    if (!validateJobSecret(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const date = req.body?.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
      ? req.body.date
      : tcOutlook.todayART();
    await captureMorningNews(date);
    const result = await tcOutlook.generateOutlook(date, {
      force: true,
      kind: 'estimate',
      source: 'cron',
    });
    const status = result.ok ? 200 : 400;
    res.status(status).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- API: memoria diaria + recomendación de timing ---
const isDateStr = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

async function captureMorningNews(date, { force = false } = {}) {
  try {
    const news = await getNews();
    const result = await tcDayMemory.captureMorning(date, news.items || [], { force });
    if (result.captured) {
      console.log(`[tc-memory] noticias de la mañana ${date}: ${result.morning.label} (score ${result.morning.newsScore}, ${result.storage})`);
    }
    return result;
  } catch (err) {
    console.warn('[tc-memory] Error capturando noticias de la mañana:', err.message);
    return { captured: false, error: err.message };
  }
}

app.get('/api/tc-reco', async (req, res) => {
  try {
    const date = isDateStr(req.query.date) ? req.query.date : tcDayMemory.todayART();
    const result = await tcTiming.getRecommendation(date, {
      log: date === tcDayMemory.todayART(),
      at: typeof req.query.at === 'string' ? req.query.at : null,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/tc-memory', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 120);
    const [days, learning] = await Promise.all([tcDayMemory.listRows(limit), tcDayMemory.learningStats()]);
    res.json({ ok: true, days, learning });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/tc-memory/:date', async (req, res) => {
  try {
    if (!isDateStr(req.params.date)) return res.status(400).json({ ok: false, error: 'Fecha inválida' });
    const row = await tcDayMemory.getRow(req.params.date);
    res.json({ ok: true, found: Boolean(row), day: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Tareas post-rueda (15:30 ART): resultado del día en la memoria, archivo de noticias
 * y análisis de cierre. Idempotente: si el análisis de cierre ya existe, no se regenera.
 */
async function runCloseJobs(date) {
  const summary = { date, errors: [] };
  try {
    const result = await tcDayMemory.recordOutcome(date);
    summary.memory = result.recorded ? { direction: result.outcome.direction, storage: result.storage } : { reason: result.reason };
    console.log(`[tc-memory] cierre ${date}: ${result.recorded ? `${result.outcome.direction} (${result.storage})` : result.reason}`);
  } catch (err) {
    summary.errors.push(`memoria: ${err.message}`);
    console.warn('[tc-memory] Error registrando cierre:', err.message);
  }
  try {
    const news = await getNews();
    const result = await newsArchive.archiveToday(news.items || []);
    summary.newsArchive = result.archived ? { count: result.count, storage: result.storage } : { reason: result.reason };
    console.log(`[news-archive] ${result.archived ? `${result.count} noticias archivadas (${result.storage})` : result.reason}`);
  } catch (err) {
    summary.errors.push(`noticias: ${err.message}`);
    console.warn('[news-archive] Error en cierre:', err.message);
  }
  if (tcOutlook.hasOpenAI()) {
    try {
      const stored = await tcOutlook.getStoredOutlook(date);
      if (stored?.reportKind === 'close') {
        summary.closeOutlook = 'ya-existia';
      } else {
        const outlook = await tcOutlook.generateOutlook(date, { force: true, kind: 'close', source: 'cron' });
        summary.closeOutlook = outlook.ok ? outlook.storage : outlook.error;
        console.log(`[tc-outlook] ${outlook.ok ? `cierre ${date} (${outlook.storage})` : outlook.error}`);
      }
    } catch (err) {
      summary.errors.push(`análisis de cierre: ${err.message}`);
      console.warn('[tc-outlook] Error análisis de cierre:', err.message);
    }
  }
  return summary;
}

app.post('/api/tc-memory/morning', async (req, res) => {
  if (!validateJobSecret(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const date = isDateStr(req.body?.date) ? req.body.date : tcDayMemory.todayART();
  const result = await captureMorningNews(date, { force: Boolean(req.body?.force) });
  res.status(result.error ? 500 : 200).json({ ok: !result.error, ...result });
});

/** Job externo (GitHub Actions) ~15:40 ART: respaldo del cron interno si Render estaba dormido. */
app.post('/api/tc-memory/close-run', async (req, res) => {
  if (!validateJobSecret(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const date = isDateStr(req.body?.date) ? req.body.date : tcDayMemory.todayART();
  const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
  if (date === tcDayMemory.todayART() && art.getUTCHours() < 15) {
    return res.status(400).json({ ok: false, error: 'La rueda de hoy todavía no cerró (15:00 ART).' });
  }
  const result = await runCloseJobs(date);
  res.status(result.errors.length ? 500 : 200).json({ ok: !result.errors.length, ...result });
});

// --- API: futuros ---
app.get('/api/futures', async (req, res) => {
  try {
    const futures = await getFutures();
    res.json({ ok: true, data: futures, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message, enabled: FUTURES_ENABLED });
  }
});

// --- Health check ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true, futuresEnabled: FUTURES_ENABLED, ts: new Date().toISOString() });
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Cron liviano:
 * - 08:55 ART: foto de noticias de la mañana (si el servidor arranca más tarde, se recupera
 *   hasta las 15:00 usando solo titulares publicados antes de las 10:00)
 * - 09:00 ART (±2 min): estimación pre-rueda (para aciertos)
 * - 15:30 ART: resultado del día en la memoria (también si arranca después), archivo de noticias
 *   + análisis de cierre
 */
function startNewsArchiveCron() {
  let lastEstimateDate = null;
  let lastMorningDate = null;
  let lastOutcomeDate = null;
  const tick = async () => {
    const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const h = art.getUTCHours();
    const m = art.getUTCMinutes();
    const minutes = h * 60 + m;
    const today = art.toISOString().slice(0, 10);
    const dow = art.getUTCDay(); // 0=dom … 6=sáb (aprox ART vía offset)
    const isWeekday = dow >= 1 && dow <= 5;

    if (isWeekday && minutes >= 8 * 60 + 55 && minutes < 15 * 60 && lastMorningDate !== today) {
      lastMorningDate = today;
      const result = await captureMorningNews(today);
      if (result.error) lastMorningDate = null;
    }

    if (isWeekday && minutes >= 15 * 60 + 30 && lastOutcomeDate !== today) {
      lastOutcomeDate = today;
      const result = await runCloseJobs(today);
      if (result.errors.length) lastOutcomeDate = null;
    }

    if (isWeekday && h === 9 && m < 3 && lastEstimateDate !== today && tcOutlook.hasOpenAI()) {
      lastEstimateDate = today;
      try {
        const outlook = await tcOutlook.generateOutlook(today, {
          force: true,
          kind: 'estimate',
          source: 'cron',
        });
        console.log(`[tc-outlook] ${outlook.ok ? `estimación ${today} (${outlook.storage})` : outlook.error}`);
      } catch (err) {
        console.warn('[tc-outlook] Error estimación 9:00:', err.message);
        lastEstimateDate = null;
      }
    }
  };
  setTimeout(tick, 15_000);
  setInterval(tick, 60_000);
}

// Local: levantar servidor. Vercel: exportar el app como handler.
if (require.main === module) {
  const host = process.env.HOST || '0.0.0.0';
  app.listen(PORT, host, () => {
    console.log(`\n  Dashboard TC + Noticias\n`);
    console.log(`  Escuchando en http://${host}:${PORT}`);
    console.log(`  USD (UI mayorista): ${FUTURES_ENABLED ? 'A3/Primary futuro DLR' : 'fallback Ámbito'}`);
    if (FUTURES_ENABLED) {
      startTcIntradayRecorder();
      console.log('  Gráfico intradiario: registro automático en servidor (10:00–15:00 ART)');
    }
    startNewsArchiveCron();
    console.log('  Archivo de noticias: cron activo (15:30 ART)');
    console.log('  Estimación TC: cron 09:00 ART + análisis de cierre 15:30');
    console.log('  Memoria diaria: noticias 08:55 ART + resultado 15:30 (recomendación en /api/tc-reco)');
    console.log(`  Análisis OpenAI: ${tcOutlook.hasOpenAI() ? 'activo' : 'sin OPENAI_API_KEY'}\n`);
  });
}

module.exports = app;

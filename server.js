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
    const result = await tcOutlook.getOutlook(date);
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
    const result = await tcOutlook.generateOutlook(date, { force });
    const status = result.ok ? 200 : 400;
    res.status(status).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
 * Cron liviano: cada minuto verifica si son las 15:30 ART (±30s) para archivar noticias.
 * No usa dependencias externas; un proceso persistente (Render) lo lleva bien.
 */
function startNewsArchiveCron() {
  let lastArchiveDate = null;
  setInterval(async () => {
    const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const h = art.getUTCHours();
    const m = art.getUTCMinutes();
    const today = art.toISOString().slice(0, 10);
    if (h === 15 && m >= 30 && m < 35 && lastArchiveDate !== today) {
      lastArchiveDate = today;
      try {
        const news = await getNews();
        const result = await newsArchive.archiveToday(news.items || []);
        console.log(`[news-archive] ${result.archived ? `${result.count} noticias archivadas (${result.storage})` : result.reason}`);
        if (tcOutlook.hasOpenAI()) {
          const outlook = await tcOutlook.generateOutlook(today, { force: true });
          console.log(`[tc-outlook] ${outlook.ok ? `análisis ${today} (${outlook.storage})` : outlook.error}`);
        }
      } catch (err) {
        console.warn('[news-archive] Error en cron:', err.message);
      }
    }
  }, 60_000);
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
    console.log(`  Análisis OpenAI: ${tcOutlook.hasOpenAI() ? 'activo' : 'sin OPENAI_API_KEY'}\n`);
  });
}

module.exports = app;

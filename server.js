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
  SUPABASE_ENABLED,
} = require('./src/services/projectionHistoryService');
const { getFutures, ENABLED: FUTURES_ENABLED } = require('./src/providers/futuresProvider');

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
    const rates = await getRates();
    res.json({
      ok: true,
      data: rates,
      fetchedAt: new Date().toISOString(),
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
        storage: SUPABASE_ENABLED ? 'supabase' : 'local-file',
      });
    }

    const { projection } = await buildProjectionSnapshot('preview');
    res.json({ ok: true, data: projection, stored: false, preview: true });
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

// Local: levantar servidor. Vercel: exportar el app como handler.
if (require.main === module) {
  const host = process.env.HOST || '0.0.0.0';
  app.listen(PORT, host, () => {
    console.log(`\n  Dashboard TC + Noticias\n`);
    console.log(`  Escuchando en http://${host}:${PORT}`);
    console.log(`  USD (UI mayorista): ${FUTURES_ENABLED ? 'A3/Primary futuro DLR' : 'fallback Ámbito'}\n`);
  });
}

module.exports = app;

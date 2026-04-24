require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { getRates }           = require('./src/services/exchangeService');
const { getNews }            = require('./src/services/newsService');
const { calculateProjection } = require('./src/services/projectionService');
const { getFutures, ENABLED: FUTURES_ENABLED } = require('./src/providers/futuresProvider');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API: tipos de cambio ---
app.get('/api/fx', async (req, res) => {
  try {
    const rates = await getRates();
    res.json({ ok: true, data: rates, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// --- API: proyección intradiaria ---
app.get('/api/projection', async (req, res) => {
  try {
    const [rates, futures] = await Promise.all([getRates(), getFutures()]);
    const spot = rates.usd?.venta;
    if (!spot) return res.status(503).json({ ok: false, error: 'Sin cotización spot' });
    const contracts = futures.contracts || [];
    const projection = calculateProjection(spot, contracts);
    res.json({ ok: true, data: projection });
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
  app.listen(PORT, () => {
    console.log(`\n  Dashboard TC + Noticias\n`);
    console.log(`  Local: http://localhost:${PORT}`);
    console.log(`  Futuros: ${FUTURES_ENABLED ? 'ACTIVO' : 'desactivado (fase 2)'}\n`);
  });
}

module.exports = app;

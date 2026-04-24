require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { getRates }           = require('./src/services/exchangeService');
const { getNews }            = require('./src/services/newsService');
const { calculateProjection }                         = require('./src/services/projectionService');
const { saveProjection, recordClose, getHistory } = require('./src/services/projectionHistoryService');
const { getFutures, ENABLED: FUTURES_ENABLED } = require('./src/providers/futuresProvider');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mes abreviado español → número
const MONTH_NUM = { ENE:1,FEB:2,MAR:3,ABR:4,MAY:5,JUN:6,JUL:7,AGO:8,SEP:9,OCT:10,NOV:11,DIC:12 };

function nearestRofexSpot(contracts) {
  if (!contracts?.length) return null;
  const now = Date.now();

  const scored = contracts
    .map(c => {
      const m = c.symbol?.match(/([A-Z]{3})(\d{2})$/);
      if (!m) return null;
      const mon = MONTH_NUM[m[1]];
      if (!mon) return null;
      const year = 2000 + parseInt(m[2], 10);
      // Último día hábil del mes = aproximamos al día 20 para no pasarnos
      const expiry = new Date(year, mon - 1, 20).getTime();
      const price  = c.lastPrice ?? c.bid ?? c.ask;
      if (!price) return null;
      return { symbol: c.symbol, price, expiry, diff: expiry - now };
    })
    .filter(x => x !== null)
    // Solo contratos que no hayan vencido aún (diff > -7 días de margen)
    .filter(x => x.diff > -7 * 24 * 3600 * 1000)
    .sort((a, b) => a.diff - b.diff); // más cercano primero

  return scored[0] ?? null;
}

// --- API: tipos de cambio ---
app.get('/api/fx', async (req, res) => {
  try {
    const [rates, futures] = await Promise.all([
      getRates(),
      getFutures().catch(() => ({ contracts: [] })),
    ]);

    const rofex = nearestRofexSpot(futures.contracts);
    const data  = {
      ...rates,
      rofexSpot: rofex
        ? { symbol: rofex.symbol, price: rofex.price, fuente: 'Matba-Rofex' }
        : null,
    };

    res.json({ ok: true, data, fetchedAt: new Date().toISOString() });
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

// --- API: guardar proyección del día ---
app.post('/api/projection/record', async (req, res) => {
  try {
    const [rates, futures] = await Promise.all([getRates(), getFutures()]);
    const spot = rates.usd?.venta;
    if (!spot) return res.status(503).json({ ok: false, error: 'Sin cotización spot' });
    const projection = calculateProjection(spot, futures.contracts || []);
    const result = saveProjection(projection);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- API: registrar precio de cierre real ---
app.post('/api/projection/close', async (req, res) => {
  try {
    const { closePrice } = req.body;
    if (!closePrice || isNaN(closePrice)) {
      return res.status(400).json({ ok: false, error: 'closePrice requerido' });
    }
    const result = recordClose(Number(closePrice));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- API: historial de proyecciones ---
app.get('/api/projection/history', (req, res) => {
  try {
    res.json({ ok: true, ...getHistory() });
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

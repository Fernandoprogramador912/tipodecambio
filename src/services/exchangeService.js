const axios = require('axios');
const { record } = require('./historyService');

const DOLAR_API_BASE = 'https://dolarapi.com/v1';
const AMBITO_BASE    = 'https://mercados.ambito.com';
const CACHE_TTL_MS   = 8000; // 8s — un poco menos que el intervalo de 10s del frontend

let cache = {
  data: null,
  fetchedAt: 0,
};

// Parsea números con coma decimal (formato Ambito: "1.392,50" → 1392.50)
function parseAmbito(str) {
  if (str == null) return null;
  const clean = String(str).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

// Parsea "24/04/2026 - 13:45" → ISO string
function parseAmbitoDate(str) {
  try {
    const [datePart, timePart] = str.split(' - ');
    const [d, m, y] = datePart.split('/');
    return new Date(`${y}-${m}-${d}T${timePart}:00-03:00`).toISOString();
  } catch { return null; }
}

async function fetchMayorista() {
  // Fuente primaria: Ambito (actualiza intradiario durante la rueda)
  try {
    const res = await axios.get(`${AMBITO_BASE}/dolar/mayorista/variacion`, { timeout: 5000 });
    const d   = res.data;
    const compra = parseAmbito(d.compra);
    const venta  = parseAmbito(d.venta);
    if (!compra || !venta) throw new Error('Datos Ambito inválidos');
    return {
      nombre: 'Mayorista',
      compra,
      venta,
      spread:             venta && compra ? +(venta - compra).toFixed(4) : null,
      variacion:          d.variacion || null,
      valorCierreAnt:     parseAmbito(d.valor_cierre_ant),
      fechaActualizacion: parseAmbitoDate(d.fecha),
      fuente: 'Ambito.com',
    };
  } catch {
    // Fallback: DolarApi.com
    const res = await axios.get(`${DOLAR_API_BASE}/dolares/mayorista`, { timeout: 5000 });
    const d   = res.data;
    return {
      nombre:             d.nombre || 'Mayorista',
      compra:             d.compra,
      venta:              d.venta,
      spread:             d.venta && d.compra ? +(d.venta - d.compra).toFixed(4) : null,
      variacion:          null,
      valorCierreAnt:     null,
      fechaActualizacion: d.fechaActualizacion,
      fuente: 'DolarApi.com',
    };
  }
}

async function fetchRates() {
  const [usd, euro, mep] = await Promise.all([
    fetchMayorista(),
    axios.get(`${DOLAR_API_BASE}/cotizaciones/eur`, { timeout: 5000 }).then(r => r.data),
    axios.get(`${DOLAR_API_BASE}/dolares/bolsa`,    { timeout: 5000 }).then(r => r.data).catch(() => null),
  ]);

  // Spread MEP vs Mayorista
  const mepVenta       = mep?.venta  ?? null;
  const mayoristaVenta = usd.venta   ?? null;
  const spreadMonto    = mepVenta && mayoristaVenta ? +(mepVenta - mayoristaVenta).toFixed(2) : null;
  const spreadPct      = spreadMonto && mayoristaVenta
    ? +(spreadMonto / mayoristaVenta * 100).toFixed(2)
    : null;

  return {
    usd,
    eur: {
      nombre:             euro.nombre || 'Euro',
      compra:             euro.compra,
      venta:              euro.venta,
      spread:             euro.venta && euro.compra ? +(euro.venta - euro.compra).toFixed(4) : null,
      fechaActualizacion: euro.fechaActualizacion,
      fuente: 'DolarApi.com',
    },
    mep: mep ? {
      nombre:             'MEP (Bolsa)',
      compra:             mep.compra,
      venta:              mep.venta,
      fechaActualizacion: mep.fechaActualizacion,
      fuente: 'DolarApi.com',
    } : null,
    spreadMepMayorista: { montoARS: spreadMonto, pct: spreadPct },
  };
}

async function getRates() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { ...cache.data, cached: true };
  }

  try {
    const rates = await fetchRates();
    cache = { data: rates, fetchedAt: now };

    if (rates.usd?.venta && rates.usd?.compra) {
      record(rates.usd.compra, rates.usd.venta, new Date().toISOString());
    }

    return { ...rates, cached: false };
  } catch (err) {
    if (cache.data) {
      return { ...cache.data, cached: true, stale: true, error: err.message };
    }
    throw err;
  }
}

module.exports = { getRates };

const axios = require('axios');
const { record } = require('./historyService');

const DOLAR_API_BASE = 'https://dolarapi.com/v1';
const CACHE_TTL_MS = 8000; // 8s — un poco menos que el intervalo de 10s del frontend

let cache = {
  data: null,
  fetchedAt: 0,
};

async function fetchWithFallback(primaryUrl, fallbackUrl) {
  try {
    const res = await axios.get(primaryUrl, { timeout: 5000 });
    return res.data;
  } catch (primaryErr) {
    if (fallbackUrl) {
      const res = await axios.get(fallbackUrl, { timeout: 5000 });
      return res.data;
    }
    throw primaryErr;
  }
}

async function fetchRates() {
  const [mayorista, euro] = await Promise.all([
    fetchWithFallback(`${DOLAR_API_BASE}/dolares/mayorista`),
    fetchWithFallback(`${DOLAR_API_BASE}/cotizaciones/eur`),
  ]);

  return {
    usd: {
      nombre: mayorista.nombre || 'Mayorista',
      compra: mayorista.compra,
      venta: mayorista.venta,
      spread: mayorista.venta && mayorista.compra
        ? +(mayorista.venta - mayorista.compra).toFixed(4)
        : null,
      fechaActualizacion: mayorista.fechaActualizacion,
      fuente: 'DolarApi.com',
    },
    eur: {
      nombre: euro.nombre || 'Euro',
      compra: euro.compra,
      venta: euro.venta,
      spread: euro.venta && euro.compra
        ? +(euro.venta - euro.compra).toFixed(4)
        : null,
      fechaActualizacion: euro.fechaActualizacion,
      fuente: 'DolarApi.com',
    },
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

    // Registrar punto histórico usando el timestamp de fetch (no el de la fuente)
    if (rates.usd?.venta && rates.usd?.compra) {
      record(rates.usd.compra, rates.usd.venta, new Date().toISOString());
    }

    return { ...rates, cached: false };
  } catch (err) {
    if (cache.data) {
      // Devuelve el último dato válido con flag de error
      return { ...cache.data, cached: true, stale: true, error: err.message };
    }
    throw err;
  }
}

module.exports = { getRates };

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD en UTC
}

function filePath(dateKey) {
  return path.join(DATA_DIR, `history-${dateKey}.json`);
}

function loadToday() {
  const fp = filePath(todayKey());
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return [];
  }
}

// Puntos en memoria para el día en curso
let todayPoints = loadToday();
let currentDateKey = todayKey();

/**
 * Registra un punto de cotización USD/ARS.
 * @param {number} compra
 * @param {number} venta
 * @param {string} isoTimestamp
 */
function record(compra, venta, isoTimestamp) {
  // Rotar si cambió el día
  const dk = todayKey();
  if (dk !== currentDateKey) {
    todayPoints = [];
    currentDateKey = dk;
  }

  const point = { ts: isoTimestamp, compra, venta };
  todayPoints.push(point);

  // Persistir de forma no bloqueante
  fs.writeFile(filePath(dk), JSON.stringify(todayPoints), () => {});
}

/**
 * Devuelve los puntos del día actual, opcionalmente filtrados al rango de rueda.
 * Formato: [{ ts, compra, venta }, ...]
 */
function getTodayHistory({ onlyTradingHours = true } = {}) {
  // Asegurar que tenemos los datos del día correcto
  const dk = todayKey();
  if (dk !== currentDateKey) {
    todayPoints = loadToday();
    currentDateKey = dk;
  }

  if (!onlyTradingHours) return todayPoints;

  // Filtrar por horario de rueda: 13:00–18:00 UTC (= 10:00–15:00 ART, UTC-3)
  return todayPoints.filter(p => {
    const d = new Date(p.ts);
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const totalMins = h * 60 + m;
    return totalMins >= 13 * 60 && totalMins <= 18 * 60;
  });
}

module.exports = { record, getTodayHistory };

/**
 * Historial de proyecciones y registro de aciertos.
 *
 * Almacenamiento:
 *  - Local: data/projection-history.json (persistente)
 *  - Vercel serverless: en memoria por sesión (se pierde al reiniciar la función)
 *    Para persistencia en producción, configurar Supabase (ver .env.example)
 */

const fs   = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '../../data/projection-history.json');

// ── Persistencia local ────────────────────────────────────────────────────────

function readFile() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return { records: [] };
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { records: [] };
  }
}

function writeFile(data) {
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false; // Silencioso en Vercel (filesystem read-only)
  }
}

// ── Memoria (fallback para Vercel) ────────────────────────────────────────────

let memoryStore = null;

function getStore() {
  if (memoryStore === null) {
    memoryStore = readFile();
  }
  return memoryStore;
}

function saveStore(data) {
  memoryStore = data;
  writeFile(data); // intenta persistir en disco (no-op en Vercel)
}

// ── Utilidades ────────────────────────────────────────────────────────────────

function todayART() {
  // Fecha del día en Argentina (UTC-3)
  const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return art.toISOString().slice(0, 10);
}

function calcAccuracy(direction, spot, actualClose) {
  const isAlcista = direction.arrow.includes('▲') || direction.arrow.includes('↗');
  const isBajista = direction.arrow.includes('▼') || direction.arrow.includes('↘');
  const isNeutro  = !isAlcista && !isBajista;

  if (isAlcista) return actualClose > spot;
  if (isBajista) return actualClose < spot;
  if (isNeutro)  return Math.abs(actualClose - spot) / spot < 0.0005; // estable = <0.05%
  return null;
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Guarda la proyección del día si no existe aún.
 * Idempotente: si ya hay un registro para hoy, no lo sobreescribe.
 */
function saveProjection(projection) {
  const store  = getStore();
  const today  = todayART();
  const exists = store.records.find(r => r.date === today);
  if (exists) return { saved: false, reason: 'Ya existe un registro para hoy', record: exists };

  const record = {
    date:             today,
    dayName:          projection.dayName,
    direction:        projection.direction.label,
    directionArrow:   projection.direction.arrow,
    directionTag:     projection.direction.tag,
    totalScore:       projection.totalScore,
    estimatedMin:     projection.rangeMin,
    estimatedMax:     projection.rangeMax,
    variacion:        projection.variacionEstimada,
    spot:             projection.spot,
    futuresSymbol:    projection.signals.find(s => s.tipo === 'futuros')?.descripcion?.split('→')[0]?.trim() || null,
    recommendation:   projection.recommendation,
    actualClose:      null,
    wasDirectionCorrect: null,
    wasInRange:          null,
    savedAt:          new Date().toISOString(),
    closedAt:         null,
  };

  store.records.push(record);
  store.records.sort((a, b) => b.date.localeCompare(a.date)); // más reciente primero
  saveStore(store);

  return { saved: true, record };
}

/**
 * Registra el precio de cierre real y calcula si la proyección fue correcta.
 * Solo se ejecuta una vez (si actualClose ya está seteado, no sobreescribe).
 */
function recordClose(actualClose) {
  const store  = getStore();
  const today  = todayART();
  const record = store.records.find(r => r.date === today);

  if (!record) return { updated: false, reason: 'Sin proyección registrada para hoy' };
  if (record.actualClose !== null) return { updated: false, reason: 'Cierre ya registrado', record };

  record.actualClose        = actualClose;
  record.wasDirectionCorrect = calcAccuracy(
    { arrow: record.directionArrow },
    record.spot,
    actualClose
  );
  record.wasInRange = actualClose >= record.estimatedMin && actualClose <= record.estimatedMax;
  record.closedAt   = new Date().toISOString();

  saveStore(store);
  return { updated: true, record };
}

/**
 * Devuelve todos los registros con estadísticas de aciertos.
 */
function getHistory() {
  const store   = getStore();
  const records = store.records;

  const closed  = records.filter(r => r.actualClose !== null);
  const correct = closed.filter(r => r.wasDirectionCorrect === true);
  const inRange = closed.filter(r => r.wasInRange === true);

  return {
    records,
    stats: {
      total:         records.length,
      closed:        closed.length,
      pending:       records.length - closed.length,
      directionAccuracy: closed.length > 0
        ? +(correct.length / closed.length * 100).toFixed(1)
        : null,
      rangeAccuracy: closed.length > 0
        ? +(inRange.length / closed.length * 100).toFixed(1)
        : null,
    },
  };
}

module.exports = { saveProjection, recordClose, getHistory };

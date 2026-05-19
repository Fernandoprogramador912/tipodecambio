/**
 * Historial de proyecciones y registro de aciertos.
 *
 * Almacenamiento:
 *  - Local: data/projection-history.json (persistente)
 *  - Vercel serverless: en memoria por sesión (se pierde al reiniciar la función)
 *    Para persistencia en producción, configurar Supabase (ver .env.example)
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const HISTORY_FILE = path.join(__dirname, '../../data/projection-history.json');
const SUPABASE_URL = (process.env.SUPABASE_URL || '')
  .replace(/\/rest\/v1\/?$/, '')
  .replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_TABLE = process.env.SUPABASE_DAILY_PROJECTIONS_TABLE || 'daily_projections';
const SUPABASE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_KEY);

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

function projectionDateFromRow(row) {
  return row.projection_date || row.date;
}

function mapDbRowToRecord(row) {
  const projection = row.projection || {};
  return {
    date:             projectionDateFromRow(row),
    dayName:          projection.dayName || row.day_name || null,
    direction:        row.direction,
    directionArrow:   row.direction_arrow,
    directionTag:     row.direction_tag,
    totalScore:       row.total_score,
    estimated:        row.estimated,
    estimatedMin:     row.range_min,
    estimatedMax:     row.range_max,
    variacion:        row.estimated_variation,
    spot:             row.spot,
    futuresSymbol:    projection.signals?.find(s => s.tipo === 'futuros')?.descripcion?.split('→')[0]?.trim() || null,
    recommendation:   row.recommendation,
    actualClose:      row.actual_close,
    wasDirectionCorrect: row.was_direction_correct,
    wasInRange:          row.was_in_range,
    savedAt:          row.created_at || row.generated_at,
    closedAt:         row.closed_at,
    projection,
    inputs:           row.inputs || null,
  };
}

function projectionToDbRow(projection, inputs = {}) {
  const today = todayART();
  return {
    projection_date: today,
    generated_at: projection.generatedAt || new Date().toISOString(),
    spot: projection.spot,
    direction: projection.direction.label,
    direction_arrow: projection.direction.arrow,
    direction_tag: projection.direction.tag,
    total_score: projection.totalScore,
    estimated: projection.estimated,
    range_min: projection.rangeMin,
    range_max: projection.rangeMax,
    estimated_variation: projection.variacionEstimada,
    recommendation: projection.recommendation,
    disclaimer: projection.disclaimer,
    projection,
    inputs,
  };
}

async function supabaseRequest(method, pathSuffix, data = undefined, extraHeaders = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${pathSuffix}`;
  const res = await axios.request({
    method,
    url,
    data,
    timeout: 10_000,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
  return res.data;
}

async function getSupabaseRowByDate(date = todayART()) {
  if (!SUPABASE_ENABLED) return null;
  const rows = await supabaseRequest(
    'get',
    `${SUPABASE_TABLE}?projection_date=eq.${date}&limit=1`
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function insertSupabaseProjection(projection, inputs = {}) {
  const row = projectionToDbRow(projection, inputs);
  const inserted = await supabaseRequest('post', SUPABASE_TABLE, row, {
    Prefer: 'return=representation',
  });
  return Array.isArray(inserted) ? inserted[0] : inserted;
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
async function saveProjection(projection, inputs = {}) {
  if (SUPABASE_ENABLED) {
    const existing = await getSupabaseRowByDate();
    if (existing) {
      return {
        saved: false,
        reason: 'Ya existe un registro para hoy',
        record: mapDbRowToRecord(existing),
        storage: 'supabase',
      };
    }

    try {
      const inserted = await insertSupabaseProjection(projection, inputs);
      return { saved: true, record: mapDbRowToRecord(inserted), storage: 'supabase' };
    } catch (err) {
      // Si dos jobs corren a la vez, la restricción unique evita duplicados.
      if (err.response?.status === 409) {
        const duplicate = await getSupabaseRowByDate();
        return {
          saved: false,
          reason: 'Ya existe un registro para hoy',
          record: mapDbRowToRecord(duplicate),
          storage: 'supabase',
        };
      }
      throw err;
    }
  }

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
    estimated:        projection.estimated,
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
    projection,
    inputs,
  };

  store.records.push(record);
  store.records.sort((a, b) => b.date.localeCompare(a.date)); // más reciente primero
  saveStore(store);

  return { saved: true, record, storage: 'local-file' };
}

/**
 * Registra el precio de cierre real y calcula si la proyección fue correcta.
 * Solo se ejecuta una vez (si actualClose ya está seteado, no sobreescribe).
 */
async function recordClose(actualClose) {
  if (SUPABASE_ENABLED) {
    const row = await getSupabaseRowByDate();
    if (!row) return { updated: false, reason: 'Sin proyección registrada para hoy', storage: 'supabase' };
    if (row.actual_close !== null) {
      return { updated: false, reason: 'Cierre ya registrado', record: mapDbRowToRecord(row), storage: 'supabase' };
    }

    const wasDirectionCorrect = calcAccuracy(
      { arrow: row.direction_arrow },
      Number(row.spot),
      actualClose
    );
    const wasInRange = actualClose >= Number(row.range_min) && actualClose <= Number(row.range_max);

    const updatedRows = await supabaseRequest(
      'patch',
      `${SUPABASE_TABLE}?projection_date=eq.${todayART()}`,
      {
        actual_close: actualClose,
        was_direction_correct: wasDirectionCorrect,
        was_in_range: wasInRange,
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { Prefer: 'return=representation' }
    );
    const updated = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;
    return { updated: true, record: mapDbRowToRecord(updated), storage: 'supabase' };
  }

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
async function getTodayProjection() {
  if (SUPABASE_ENABLED) {
    const row = await getSupabaseRowByDate();
    return row ? mapDbRowToRecord(row) : null;
  }

  const store = getStore();
  const record = store.records.find(r => r.date === todayART());
  return record || null;
}

async function getHistory() {
  if (SUPABASE_ENABLED) {
    const rows = await supabaseRequest(
      'get',
      `${SUPABASE_TABLE}?select=*&order=projection_date.desc`
    );
    const records = (rows || []).map(mapDbRowToRecord);
    const closed  = records.filter(r => r.actualClose !== null);
    const correct = closed.filter(r => r.wasDirectionCorrect === true);
    const inRange = closed.filter(r => r.wasInRange === true);

    return {
      records,
      storage: 'supabase',
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

  const store   = getStore();
  const records = store.records;

  const closed  = records.filter(r => r.actualClose !== null);
  const correct = closed.filter(r => r.wasDirectionCorrect === true);
  const inRange = closed.filter(r => r.wasInRange === true);

  return {
    records,
    storage: 'local-file',
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

module.exports = {
  saveProjection,
  recordClose,
  getHistory,
  getTodayProjection,
  SUPABASE_ENABLED,
};

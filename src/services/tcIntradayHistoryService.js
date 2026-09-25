/**
 * Historial intradiario USD/ARS (10:00–15:00 ART) por día de rueda.
 * Solo acumula desde TC_HISTORY_START_DATE (por defecto: hoy al activar).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const HISTORY_FILE = path.join(__dirname, '../../data/tc-intraday-history.json');
const SUPABASE_URL = (process.env.SUPABASE_URL || '')
  .replace(/\/rest\/v1\/?$/, '')
  .replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_TABLE = process.env.SUPABASE_TC_INTRADAY_TABLE || 'tc_intraday_days';
const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_KEY);
let supabaseUsable = SUPABASE_CONFIGURED;

function isSupabaseActive() {
  return supabaseUsable;
}

async function withStorage(supabaseFn, localFn) {
  if (!supabaseUsable) return localFn();
  try {
    return await supabaseFn();
  } catch (err) {
    const missing = err.response?.status === 404
      || err.response?.data?.code === 'PGRST205';
    if (missing) {
      console.warn('[tc-history] Tabla Supabase no encontrada; usando archivo local.');
      supabaseUsable = false;
      return localFn();
    }
    throw err;
  }
}

function todayART() {
  const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return art.toISOString().slice(0, 10);
}

function dateARTFromTs(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return new Date(t.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function pointBelongsToDate(point, dateStr) {
  return dateARTFromTs(point?.ts) === dateStr;
}

function filterIsolatedSpikes(points) {
  if (!Array.isArray(points) || points.length < 3) return points || [];
  return points.filter((p, i) => {
    const prev = points[i - 1];
    const next = points[i + 1];
    if (!prev || !next) return true;
    const drop = prev.venta - p.venta;
    const rebound = next.venta - p.venta;
    return !(drop >= 3 && rebound >= 3);
  });
}

function getHistoryStartDate() {
  return process.env.TC_HISTORY_START_DATE || todayART();
}

function isValidDateStr(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function isOnOrAfterStart(dateStr) {
  return isValidDateStr(dateStr) && dateStr >= getHistoryStartDate();
}

function normalizePoint(raw) {
  const venta = Number(raw?.venta);
  if (!Number.isFinite(venta)) return null;
  const ts = raw?.ts ? new Date(raw.ts).toISOString() : new Date().toISOString();
  return { ts, venta, compra: Number(raw?.compra) || venta };
}

function mergePoints(existing, incoming, dateStr = null) {
  const map = new Map();
  for (const p of [...(existing || []), ...(incoming || [])]) {
    const norm = normalizePoint(p);
    if (!norm) continue;
    if (dateStr && !pointBelongsToDate(norm, dateStr)) continue;
    map.set(norm.ts, norm);
  }
  return [...map.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

let memoryStore = null;

function readFile() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return { startDate: getHistoryStartDate(), days: {} };
    }
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!data.startDate) data.startDate = getHistoryStartDate();
    if (!data.days) data.days = {};
    return data;
  } catch {
    return { startDate: getHistoryStartDate(), days: {} };
  }
}

function writeFile(data) {
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

function getStore() {
  if (memoryStore === null) memoryStore = readFile();
  return memoryStore;
}

function saveStore(data) {
  memoryStore = data;
  writeFile(data);
}

async function supabaseRequest(method, pathSuffix, data = undefined, extraHeaders = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${pathSuffix}`;
  const res = await axios.request({
    method,
    url,
    data,
    timeout: 12_000,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
  return res.data;
}

function mapDbRow(row) {
  return {
    date: row.session_date,
    points: Array.isArray(row.points) ? row.points : [],
    pointCount: row.point_count ?? (row.points?.length || 0),
    updatedAt: row.updated_at,
  };
}

async function getSupabaseDay(dateStr) {
  const rows = await supabaseRequest(
    'get',
    `${SUPABASE_TABLE}?session_date=eq.${dateStr}&select=session_date,points,point_count,updated_at&limit=1`
  );
  return Array.isArray(rows) && rows.length > 0 ? mapDbRow(rows[0]) : null;
}

async function upsertSupabaseDay(dateStr, points) {
  const payload = {
    session_date: dateStr,
    points,
    point_count: points.length,
    updated_at: new Date().toISOString(),
  };
  const rows = await supabaseRequest(
    'post',
    `${SUPABASE_TABLE}?on_conflict=session_date`,
    payload,
    { Prefer: 'resolution=merge-duplicates,return=representation' }
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  return mapDbRow(row);
}

async function listSupabaseDays() {
  const start = getHistoryStartDate();
  const rows = await supabaseRequest(
    'get',
    `${SUPABASE_TABLE}?session_date=gte.${start}&select=session_date,point_count,updated_at&order=session_date.desc`
  );
  return (rows || []).map(mapDbRow);
}

function listLocalDays() {
  const store = getStore();
  const start = getHistoryStartDate();
  return Object.keys(store.days)
    .filter(date => date >= start && (store.days[date]?.points?.length || 0) > 0)
    .sort((a, b) => b.localeCompare(a))
    .map(date => ({
      date,
      pointCount: store.days[date].points.length,
      updatedAt: store.days[date].updatedAt,
    }));
}

function getLocalDay(dateStr) {
  const store = getStore();
  const day = store.days[dateStr];
  if (!day) return { date: dateStr, points: [], pointCount: 0 };
  return {
    date: dateStr,
    points: day.points || [],
    pointCount: (day.points || []).length,
    updatedAt: day.updatedAt,
  };
}

function saveLocalDay(dateStr, points) {
  const store = getStore();
  if (!store.startDate) store.startDate = getHistoryStartDate();
  store.days[dateStr] = {
    points,
    updatedAt: new Date().toISOString(),
  };
  saveStore(store);
}

/**
 * Registra un punto de la rueda (solo fechas >= inicio del historial).
 */
async function addPoint(venta, compra, ts = new Date().toISOString()) {
  const point = normalizePoint({ ts, venta, compra });
  if (!point) return { saved: false, reason: 'invalid-point' };

  const dateStr = dateARTFromTs(point.ts) || todayART();
  if (!isOnOrAfterStart(dateStr)) return { saved: false, reason: 'before-start' };
  if (dateStr !== todayART()) return { saved: false, reason: 'not-today' };

  return withStorage(async () => {
    const current = await getSupabaseDay(dateStr);
    const merged = mergePoints(current?.points, [point], dateStr);
    const cleaned = filterIsolatedSpikes(merged);
    await upsertSupabaseDay(dateStr, cleaned);
    return { saved: true, date: dateStr, pointCount: merged.length, storage: 'supabase' };
  }, () => {
    const current = getLocalDay(dateStr);
    const merged = mergePoints(current.points, [point], dateStr);
    const cleaned = filterIsolatedSpikes(merged);
    saveLocalDay(dateStr, cleaned);
    return { saved: true, date: dateStr, pointCount: merged.length, storage: 'local-file' };
  });
}

async function getDay(dateStr) {
  if (!isOnOrAfterStart(dateStr)) {
    return { date: dateStr, points: [], pointCount: 0, allowed: false };
  }

  const wrap = (row, storage) => {
    const points = filterIsolatedSpikes(mergePoints(row?.points || [], [], dateStr));
    return {
      date: dateStr,
      points,
      pointCount: points.length,
      updatedAt: row?.updatedAt || null,
      storage,
      allowed: true,
    };
  };

  return withStorage(async () => {
    const row = await getSupabaseDay(dateStr);
    return wrap(row, 'supabase');
  }, () => {
    const local = getLocalDay(dateStr);
    return wrap(local, 'local-file');
  });
}

async function listDays() {
  const startDate = getHistoryStartDate();
  const days = await withStorage(() => listSupabaseDays(), () => listLocalDays());
  return {
    startDate,
    days: days.filter(d => d.date >= startDate),
    storage: isSupabaseActive() ? 'supabase' : 'local-file',
  };
}

/**
 * Fusiona días enviados desde localStorage del navegador (migración / respaldo).
 */
async function syncDays(daysPayload = {}) {
  const synced = [];
  for (const [dateStr, points] of Object.entries(daysPayload)) {
    if (!isOnOrAfterStart(dateStr) || !Array.isArray(points) || points.length === 0) continue;

    const mergedIncoming = mergePoints([], points);
    if (mergedIncoming.length === 0) continue;

    await withStorage(async () => {
      const current = await getSupabaseDay(dateStr);
      const merged = mergePoints(current?.points, mergedIncoming);
      await upsertSupabaseDay(dateStr, merged);
      synced.push({ date: dateStr, pointCount: merged.length });
    }, () => {
      const current = getLocalDay(dateStr);
      const merged = mergePoints(current.points, mergedIncoming);
      saveLocalDay(dateStr, merged);
      synced.push({ date: dateStr, pointCount: merged.length });
    });
  }
  return { synced, startDate: getHistoryStartDate() };
}

// --- Analytics ---

function toARTMin(isoStr) {
  const artMs = new Date(isoStr).getTime() - 3 * 60 * 60 * 1000;
  const art = new Date(artMs);
  return art.getUTCHours() * 60 + art.getUTCMinutes();
}

function slotLabel(artMin) {
  return String(Math.floor(artMin / 60)).padStart(2, '0') + ':' +
         String(artMin % 60).padStart(2, '0');
}

/** Downsamples points to slotMin-minute grid; last value per slot wins. */
function downsamplePoints(points, slotMin = 5) {
  if (!Array.isArray(points) || !points.length) return [];
  const slotMap = new Map();
  for (const p of [...points].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
    const norm = normalizePoint(p);
    if (!norm) continue;
    const artMin = toARTMin(norm.ts);
    const slotIdx = Math.floor((artMin - 10 * 60) / slotMin);
    if (slotIdx < 0 || slotIdx > (5 * 60) / slotMin) continue;
    slotMap.set(slotIdx, norm);
  }
  return [...slotMap.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Compute summary stats from an array of points (solo 10:00–15:00 ART). */
function computeDaySummary(points) {
  if (!Array.isArray(points) || !points.length) return null;
  const valid = points.filter(p => {
    if (!Number.isFinite(p.venta)) return false;
    const m = toARTMin(p.ts);
    return m >= 10 * 60 && m <= 15 * 60; // rueda 10:00–15:00 ART
  });
  if (!valid.length) return null;
  const ventas = valid.map(p => p.venta);
  const minVal = Math.min(...ventas);
  const maxVal = Math.max(...ventas);
  const minPt = valid.find(p => p.venta === minVal);
  const maxPt = valid.find(p => p.venta === maxVal);
  const avg = +(ventas.reduce((a, b) => a + b, 0) / ventas.length).toFixed(2);
  return {
    open: valid[0].venta,
    close: valid[valid.length - 1].venta,
    min: minVal,
    max: maxVal,
    avg,
    range: +(maxVal - minVal).toFixed(2),
    minAt: minPt ? slotLabel(toARTMin(minPt.ts)) : null,
    maxAt: maxPt ? slotLabel(toARTMin(maxPt.ts)) : null,
    pointCount: valid.length,
  };
}

async function getDaySummary(dateStr) {
  const day = await getDay(dateStr);
  const summary = computeDaySummary(day.points);
  if (!summary) return { date: dateStr, pointCount: 0, allowed: day.allowed };

  let cierreAnterior = null;
  try {
    const weekendOrHoliday = (d) => {
      const [y, m, dayNum] = d.split('-').map(Number);
      const dow = new Date(y, m - 1, dayNum).getDay();
      if (dow === 0 || dow === 6) return true;
      const holidays = new Set([
        '2026-01-01', '2026-02-16', '2026-02-17', '2026-03-24', '2026-04-02',
        '2026-04-03', '2026-05-01', '2026-05-25', '2026-06-15', '2026-06-20',
        '2026-07-09', '2026-08-17', '2026-10-12', '2026-11-20', '2026-12-08',
        '2026-12-25',
      ]);
      return holidays.has(d);
    };
    const index = await listDays();
    const prevDates = (index.days || [])
      .map(d => d.date)
      .filter(d => d < dateStr && !weekendOrHoliday(d))
      .sort()
      .reverse();

    for (const prev of prevDates) {
      const prevDay = await getDay(prev);
      const prevSummary = computeDaySummary(prevDay.points);
      if (prevSummary?.close != null) {
        cierreAnterior = { cierreValor: prevSummary.close, cierreFecha: prev };
        break;
      }
    }
  } catch { /* sin historial previo */ }

  if (!cierreAnterior) {
    try {
      const cierreStore = require('./mayoristaCierreStore');
      const ant = cierreStore.getCierreAnterior(dateStr);
      if (ant.cierreValor != null && ant.cierreFecha) cierreAnterior = ant;
    } catch { /* opcional */ }
  }

  return { date: dateStr, ...summary, cierreAnterior };
}

/**
 * Calcula estadísticas por franja horaria en los últimos N días.
 * Útil para saber a qué hora históricamente el TC estuvo más bajo.
 *
 * opts.until — fecha inclusive (YYYY-MM-DD): ventana hacia atrás desde ese día
 *              (por defecto: hoy ART). Así el patrón cambia con el calendario.
 */
async function getInsights(opts = {}) {
  const maxDays = Math.min(Number(opts.days) || 20, 60);
  const until = isValidDateStr(opts.until) ? opts.until : todayART();
  const SLOT_MIN = 5;
  const SLOTS_TOTAL = (5 * 60) / SLOT_MIN + 1; // 61 slots 10:00–15:00

  const index = await listDays();
  // listDays viene ordenado desc; filtramos <= until y tomamos los N más recientes
  const recentDays = (index.days || [])
    .filter(d => d.date <= until)
    .slice(0, maxDays);

  if (!recentDays.length) {
    return {
      daysAnalyzed: 0,
      slots: [],
      bestWindows: [],
      until,
      from: null,
      windowDays: maxDays,
      message: 'Sin datos históricos aún para esa fecha',
    };
  }

  const slotMatrix = {}; // slotIdx → [price]
  let daysWithData = 0;
  const analyzedDates = [];

  for (const d of recentDays) {
    const dayData = await getDay(d.date);
    if (!dayData.points.length) continue;
    daysWithData++;
    analyzedDates.push(d.date);
    for (const p of dayData.points) {
      const norm = normalizePoint(p);
      if (!norm) continue;
      const artMin = toARTMin(norm.ts);
      const slotIdx = Math.floor((artMin - 10 * 60) / SLOT_MIN);
      if (slotIdx < 0 || slotIdx >= SLOTS_TOTAL) continue;
      if (!slotMatrix[slotIdx]) slotMatrix[slotIdx] = [];
      slotMatrix[slotIdx].push(norm.venta);
    }
  }

  // Si "until" es hoy, no mostrar franjas que todavía no ocurrieron
  // (esas promedios venían solo de otros días y confundían).
  let slotsLimit = SLOTS_TOTAL;
  let truncatedToNow = false;
  if (until === todayART()) {
    const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const nowMin = art.getUTCHours() * 60 + art.getUTCMinutes();
    if (nowMin < 10 * 60) {
      slotsLimit = 0;
    } else if (nowMin < 15 * 60) {
      slotsLimit = Math.floor((nowMin - 10 * 60) / SLOT_MIN) + 1;
      truncatedToNow = true;
    }
    slotsLimit = Math.max(0, Math.min(SLOTS_TOTAL, slotsLimit));
  }

  const slots = [];
  for (let i = 0; i < slotsLimit; i++) {
    const artMin = 10 * 60 + i * SLOT_MIN;
    const time = slotLabel(artMin);
    const vals = (slotMatrix[i] || []).sort((a, b) => a - b);
    if (!vals.length) {
      slots.push({ time, count: 0, avg: null, min: null, max: null, p25: null, p75: null, relDev: null, relDevPct: null });
      continue;
    }
    const avg = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
    const p25 = +vals[Math.floor(vals.length * 0.25)].toFixed(2);
    const p75 = +vals[Math.min(Math.floor(vals.length * 0.75), vals.length - 1)].toFixed(2);
    slots.push({ time, count: vals.length, avg, min: +vals[0].toFixed(2), max: +vals[vals.length - 1].toFixed(2), p25, p75 });
  }

  const validAvgs = slots.filter(s => s.avg != null).map(s => s.avg);
  const globalAvg = validAvgs.length
    ? +(validAvgs.reduce((a, b) => a + b, 0) / validAvgs.length).toFixed(2)
    : null;

  for (const s of slots) {
    s.relDev = s.avg != null && globalAvg ? +(s.avg - globalAvg).toFixed(2) : null;
    s.relDevPct = s.avg != null && globalAvg ? +(((s.avg - globalAvg) / globalAvg) * 100).toFixed(3) : null;
  }

  const bestWindows = slots
    .filter(s => s.relDev != null)
    .sort((a, b) => a.relDev - b.relDev)
    .slice(0, 6)
    .map(s => ({ time: s.time, avg: s.avg, relDevPct: s.relDevPct }));

  const sortedAnalyzed = [...analyzedDates].sort();
  return {
    daysAnalyzed: daysWithData,
    globalAvg,
    slots,
    bestWindows,
    until,
    from: sortedAnalyzed[0] || null,
    to: sortedAnalyzed[sortedAnalyzed.length - 1] || null,
    windowDays: maxDays,
    truncatedToNow,
  };
}

module.exports = {
  addPoint,
  getDay,
  listDays,
  syncDays,
  getDaySummary,
  getInsights,
  downsamplePoints,
  getHistoryStartDate,
  todayART,
  SUPABASE_ENABLED: SUPABASE_CONFIGURED,
  isSupabaseActive,
};

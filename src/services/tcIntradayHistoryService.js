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

function mergePoints(existing, incoming) {
  const map = new Map();
  for (const p of [...(existing || []), ...(incoming || [])]) {
    const norm = normalizePoint(p);
    if (!norm) continue;
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
  const dateStr = todayART();
  if (!isOnOrAfterStart(dateStr)) return { saved: false, reason: 'before-start' };

  const point = normalizePoint({ ts, venta, compra });
  if (!point) return { saved: false, reason: 'invalid-point' };

  return withStorage(async () => {
    const current = await getSupabaseDay(dateStr);
    const merged = mergePoints(current?.points, [point]);
    await upsertSupabaseDay(dateStr, merged);
    return { saved: true, date: dateStr, pointCount: merged.length, storage: 'supabase' };
  }, () => {
    const current = getLocalDay(dateStr);
    const merged = mergePoints(current.points, [point]);
    saveLocalDay(dateStr, merged);
    return { saved: true, date: dateStr, pointCount: merged.length, storage: 'local-file' };
  });
}

async function getDay(dateStr) {
  if (!isOnOrAfterStart(dateStr)) {
    return { date: dateStr, points: [], pointCount: 0, allowed: false };
  }

  return withStorage(async () => {
    const row = await getSupabaseDay(dateStr);
    return {
      date: dateStr,
      points: row?.points || [],
      pointCount: row?.pointCount || 0,
      updatedAt: row?.updatedAt || null,
      storage: 'supabase',
      allowed: true,
    };
  }, () => {
    const local = getLocalDay(dateStr);
    return { ...local, storage: 'local-file', allowed: true };
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

module.exports = {
  addPoint,
  getDay,
  listDays,
  syncDays,
  getHistoryStartDate,
  todayART,
  SUPABASE_ENABLED: SUPABASE_CONFIGURED,
  isSupabaseActive,
};

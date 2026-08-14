/**
 * Archiva noticias de alto impacto al final de cada rueda (15:30 ART).
 * Guarda en Supabase (tabla tc_day_news) con fallback a archivo local.
 * Solo se graban noticias con impact = 'muy_alto' | 'alto'.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ARCHIVE_FILE = path.join(__dirname, '../../data/news-archive.json');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_TABLE = process.env.SUPABASE_NEWS_ARCHIVE_TABLE || 'tc_day_news';
const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_KEY);

const HIGH_IMPACT = new Set(['muy_alto', 'alto']);

function todayART() {
  const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return art.toISOString().slice(0, 10);
}

// ── Local file storage ──

function readFile() {
  try {
    if (!fs.existsSync(ARCHIVE_FILE)) return {};
    return JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeFile(data) {
  try {
    const dir = path.dirname(ARCHIVE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(data, null, 2));
  } catch { /* noop en entornos read-only */ }
}

// ── Supabase helpers ──

async function supabaseRequest(method, pathSuffix, data, extraHeaders = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${pathSuffix}`;
  const res = await axios.request({
    method, url, data, timeout: 10_000,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
  return res.data;
}

async function upsertSupabaseDay(dateStr, items) {
  await supabaseRequest('post', `${SUPABASE_TABLE}?on_conflict=session_date`, {
    session_date: dateStr,
    items,
    item_count: items.length,
    archived_at: new Date().toISOString(),
  }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
}

async function getSupabaseDay(dateStr) {
  const rows = await supabaseRequest('get',
    `${SUPABASE_TABLE}?session_date=eq.${dateStr}&select=session_date,items,item_count,archived_at&limit=1`
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function listSupabaseDays() {
  const rows = await supabaseRequest('get',
    `${SUPABASE_TABLE}?select=session_date,item_count,archived_at&order=session_date.desc&limit=60`
  );
  return rows || [];
}

// ── Public API ──

/**
 * Archiva las noticias del día actual (solo impact alto/muy_alto).
 * Llama desde server.js a las 15:30 ART o bajo demanda.
 */
async function archiveToday(newsItems = []) {
  const dateStr = todayART();
  const filtered = (newsItems || [])
    .filter(n => HIGH_IMPACT.has(n.impact))
    .map(({ title, pubDate, source, score, impact, link }) => ({ title, pubDate, source, score, impact, link }))
    .slice(0, 30);

  if (!filtered.length) return { archived: false, reason: 'no-high-impact-news', date: dateStr };

  if (SUPABASE_CONFIGURED) {
    try {
      await upsertSupabaseDay(dateStr, filtered);
      return { archived: true, date: dateStr, count: filtered.length, storage: 'supabase' };
    } catch (err) {
      console.warn('[news-archive] Supabase falló, usando archivo local:', err.message);
    }
  }

  const store = readFile();
  store[dateStr] = { items: filtered, archivedAt: new Date().toISOString() };
  // conservar últimos 60 días
  const keys = Object.keys(store).sort().reverse();
  if (keys.length > 60) keys.slice(60).forEach(k => delete store[k]);
  writeFile(store);
  return { archived: true, date: dateStr, count: filtered.length, storage: 'local-file' };
}

/** Devuelve las noticias archivadas de un día (o null si no existen). */
async function getNewsForDay(dateStr) {
  if (SUPABASE_CONFIGURED) {
    try {
      const row = await getSupabaseDay(dateStr);
      if (row) return { date: dateStr, items: row.items || [], archivedAt: row.archived_at };
    } catch { /* fallback */ }
  }
  const store = readFile();
  const day = store[dateStr];
  return day ? { date: dateStr, items: day.items || [], archivedAt: day.archivedAt } : null;
}

/** Lista los días con noticias archivadas. */
async function listArchivedDays() {
  if (SUPABASE_CONFIGURED) {
    try {
      const rows = await listSupabaseDays();
      return rows.map(r => ({ date: r.session_date, count: r.item_count, archivedAt: r.archived_at }));
    } catch { /* fallback */ }
  }
  const store = readFile();
  return Object.keys(store)
    .sort().reverse()
    .map(date => ({ date, count: store[date].items?.length || 0, archivedAt: store[date].archivedAt }));
}

module.exports = { archiveToday, getNewsForDay, listArchivedDays, SUPABASE_ENABLED: SUPABASE_CONFIGURED };

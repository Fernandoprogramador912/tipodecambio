/**
 * Cierres mayoristas por día de rueda (ART).
 * El "cierre anterior" en UI = último cierre guardado con fecha < hoy (ART).
 */

const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '../../data/mayorista-cierre-days.json');

let memoryDays = null;

function todayART() {
  const art = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return art.toISOString().slice(0, 10);
}

function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const t = new Date(s);
  if (!Number.isNaN(t.getTime())) {
    const art = new Date(t.getTime() - 3 * 60 * 60 * 1000);
    return art.toISOString().slice(0, 10);
  }
  return null;
}

function readStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return data?.days && typeof data.days === 'object' ? data.days : {};
  } catch {
    return {};
  }
}

function writeStore(days) {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      STORE_FILE,
      JSON.stringify({ days, updatedAt: new Date().toISOString() }, null, 2),
    );
  } catch { /* noop en entornos read-only */ }
}

function getDays() {
  if (memoryDays === null) memoryDays = readStore();
  return memoryDays;
}

/** Registra un cierre oficial (fecha + precio) sin usarlo como "anterior" si es hoy. */
function recordClose(dateRaw, price) {
  const date = normalizeDate(dateRaw);
  const valor = Number(price);
  if (!date || !Number.isFinite(valor)) return;

  const days = { ...getDays() };
  days[date] = valor;
  memoryDays = days;
  writeStore(days);
}

/**
 * Cierre a mostrar en UI: última fecha guardada estrictamente anterior a hoy (ART).
 * Así, si A3 ya mandó el cierre de hoy, no reemplaza al de ayer hasta pasar 00:00.
 */
function getCierreAnterior() {
  const today = todayART();
  const days = getDays();
  const prevDates = Object.keys(days).filter(d => d < today).sort();
  if (!prevDates.length) {
    return { cierreValor: null, cierreFecha: null };
  }
  const fecha = prevDates[prevDates.length - 1];
  return { cierreValor: days[fecha], cierreFecha: fecha };
}

module.exports = {
  recordClose,
  getCierreAnterior,
  normalizeDate,
  todayART,
};

/**
 * Sube data/tc-outlook.json a Supabase (tabla tc_day_outlook).
 * Requiere: tabla creada + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY en .env
 *
 * Uso: node scripts/migrate-outlook-to-supabase.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STORE_FILE = path.join(__dirname, '../data/tc-outlook.json');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABLE = process.env.SUPABASE_TC_OUTLOOK_TABLE || 'tc_day_outlook';

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  if (!fs.existsSync(STORE_FILE)) {
    console.error('No hay', STORE_FILE);
    process.exit(1);
  }

  const store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  const rows = Object.keys(store).sort().map(date => ({
    session_date: date,
    analysis: store[date].analysis || {},
    generated_at: store[date].generatedAt || new Date().toISOString(),
  }));

  if (!rows.length) {
    console.log('Nada para migrar.');
    return;
  }

  // Probe tabla
  try {
    await axios.get(`${SUPABASE_URL}/rest/v1/${TABLE}?select=session_date&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      timeout: 12_000,
    });
  } catch (err) {
    const code = err.response?.data?.code || err.response?.status;
    console.error('No se pudo acceder a', TABLE, '→', code, err.response?.data?.message || err.message);
    console.error('Ejecutá primero scripts/tc-outlook-supabase.sql en el SQL Editor de Supabase.');
    process.exit(1);
  }

  const res = await axios.post(
    `${SUPABASE_URL}/rest/v1/${TABLE}?on_conflict=session_date`,
    rows,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      timeout: 30_000,
    }
  );

  const saved = Array.isArray(res.data) ? res.data.length : rows.length;
  console.log(`OK: ${saved} fila(s) upsert en ${TABLE}`);
  (Array.isArray(res.data) ? res.data : rows).forEach(r => {
    console.log(' -', r.session_date || r);
  });
}

main().catch(err => {
  console.error(err.response?.data || err.message);
  process.exit(1);
});

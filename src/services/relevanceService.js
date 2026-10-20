/**
 * Scoring de relevancia para impacto en tipo de cambio argentino.
 * Evalúa título + descripción de cada noticia.
 */

const HIGH_IMPACT_KEYWORDS = [
  'bcra', 'banco central', 'reservas', 'reservas netas',
  'devaluacion', 'devaluación', 'tipo de cambio', 'cepo',
  'crawling peg', 'banda cambiaria', 'flotación', 'flotacion',
  'fmi', 'fondo monetario', 'acuerdo fmi', 'desembolso',
  'dolar', 'dólar', 'mayorista', 'ccl', 'mep',
  'bonos soberanos', 'riesgo país', 'riesgo pais',
  'inflacion', 'inflación', 'ipc', 'indec',
  'tasa de interes', 'tasa de interés', 'política monetaria',
  'deuda externa', 'reestructuracion', 'reestructuración',
  'superavit', 'superávit', 'deficit', 'déficit fiscal',
  'exportaciones', 'importaciones', 'balanza comercial',
  'merval', 'acciones argentinas', 'adr',
  'depo', 'cauciones', 'lebac', 'lecap', 'bopreal',
  'economía argentina', 'economia argentina',
  'milei', 'caputo', 'secretaria hacienda', 'ministerio economia',
];

const BLUE_DOLLAR_PATTERNS = [
  /d[oó]lar\s+blue/i,
  /blue\s+(del\s+)?d[oó]lar/i,
  /tipo\s+blue/i,
  /d[oó]lar\s+informal/i,
  /cotizaci[oó]n\s+blue/i,
];

function isBlueDollarNews(item) {
  const text = `${item.title || ''} ${item.summary || ''}`;
  return BLUE_DOLLAR_PATTERNS.some(p => p.test(text));
}

const MEDIUM_IMPACT_KEYWORDS = [
  'mercados', 'bolsa', 'finanzas', 'economia', 'economía',
  'precios', 'consumo', 'salarios', 'empleo', 'desempleo',
  'pobreza', 'recesion', 'recesión', 'crecimiento', 'pbi', 'pib',
  'china', 'estados unidos', 'fed', 'tasas fed', 'petroleo', 'petróleo',
  'soja', 'commodities', 'agro', 'campo',
  'presupuesto', 'gasto público', 'gasto publico',
];

function scoreText(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let score = 0;

  for (const kw of HIGH_IMPACT_KEYWORDS) {
    if (lower.includes(kw)) score += 3;
  }
  for (const kw of MEDIUM_IMPACT_KEYWORDS) {
    if (lower.includes(kw)) score += 1;
  }

  return score;
}

function getImpactLabel(score) {
  if (score >= 9) return 'muy_alto';
  if (score >= 6) return 'alto';
  if (score >= 3) return 'medio';
  if (score >= 1) return 'bajo';
  return 'irrelevante';
}

/**
 * Filtra y ordena noticias por relevancia cambiaria.
 * @param {Array} items - Array de noticias normalizadas { title, summary, link, pubDate, source }
 * @param {Object} opts
 * @param {number} opts.minScore - Puntaje mínimo para incluir (default 1)
 * @param {number} opts.limit - Cantidad máxima a devolver (default 20)
 * @returns {Array}
 */
/** Boost chico: antes (+3) enterraba Ámbito/La Nación detrás de Infobae/iPro. */
const PRIORITY_SOURCE_BOOST = 1;
const MAX_PER_SOURCE = 7;

function scoreItem(item) {
  let score = scoreText(item.title) + scoreText(item.summary);
  const src = item.source || '';
  if (/iprofesional|infobae|cronista|ámbito|ambito|clarín|clarin|perfil|nación|nacion|economista/i.test(src)) {
    score += PRIORITY_SOURCE_BOOST;
  }
  return { ...item, score, impact: getImpactLabel(score) };
}

function scoreItems(items) {
  return items.map(scoreItem);
}

/** Evita que 2 medios se coman el ranking: tope por fuente y luego relleno. */
function diversifyBySource(sorted, limit, maxPerSource = MAX_PER_SOURCE) {
  const out = [];
  const counts = {};
  const rest = [];
  for (const item of sorted) {
    const src = item.source || '—';
    const n = counts[src] || 0;
    if (n < maxPerSource) {
      out.push(item);
      counts[src] = n + 1;
    } else {
      rest.push(item);
    }
    if (out.length >= limit) return out.slice(0, limit);
  }
  for (const item of rest) {
    if (out.length >= limit) break;
    out.push(item);
  }
  return out;
}

function filterAndRank(items, { minScore = 1, limit = 20, maxPerSource = MAX_PER_SOURCE } = {}) {
  const scored = items.some(i => i.score != null) ? items : scoreItems(items);

  const sorted = scored
    .filter(i => i.score >= minScore && !isBlueDollarNews(i))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.pubDate) - new Date(a.pubDate);
    });

  return diversifyBySource(sorted, limit, maxPerSource);
}

module.exports = { filterAndRank, scoreItems, scoreItem };

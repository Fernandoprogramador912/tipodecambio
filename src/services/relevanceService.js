/**
 * Scoring de relevancia para impacto en tipo de cambio argentino.
 * Evalúa título + descripción de cada noticia.
 */

const HIGH_IMPACT_KEYWORDS = [
  'bcra', 'banco central', 'reservas', 'reservas netas',
  'devaluacion', 'devaluación', 'tipo de cambio', 'cepo',
  'crawling peg', 'banda cambiaria', 'flotación', 'flotacion',
  'fmi', 'fondo monetario', 'acuerdo fmi', 'desembolso',
  'dolar', 'dólar', 'mayorista', 'blue', 'ccl', 'mep',
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
function filterAndRank(items, { minScore = 1, limit = 20 } = {}) {
  const scored = items.map(item => {
    const score = scoreText(item.title) + scoreText(item.summary);
    return { ...item, score, impact: getImpactLabel(score) };
  });

  return scored
    .filter(i => i.score >= minScore)
    .sort((a, b) => {
      // Primero por impacto, luego por fecha
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.pubDate) - new Date(a.pubDate);
    })
    .slice(0, limit);
}

module.exports = { filterAndRank };

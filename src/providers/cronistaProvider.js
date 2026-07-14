const Parser = require('rss-parser');

const CRONISTA_RSS = 'https://www.cronista.com/arc/outboundfeeds/rss/?outputType=xml';

/** Ediciones internacionales en el feed global (excluir). */
const INTL_SEGMENTS = new Set([
  'mexico', 'colombia', 'usa', 'en', 'espana', 'uruguay', 'chile', 'peru', 'brasil', 'portugal',
]);

const parser = new Parser({
  timeout: 12000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DashboardTC/1.0)' },
});

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/\(function\s*\([\s\S]*$/g, ' ')
    .replace(/GoogleAnalyticsObject[\s\S]*$/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function isArgentinaArticle(link) {
  try {
    const seg = new URL(link).pathname.split('/').filter(Boolean)[0] || '';
    if (!seg) return false;
    if (INTL_SEGMENTS.has(seg)) return false;
    if (seg.length === 2) return false;
    return true;
  } catch {
    return false;
  }
}

function isEconomyRelated(item) {
  const text = `${item.link || ''} ${item.title || ''} ${(item.categories || []).join(' ')}`.toLowerCase();
  return /finanzas|econom|mercado|dolar|dólar|bcra|fmi|bonos|merval|export|import|fiscal|inflaci|tasa|riesgo|mep|ccl|mayorista|caputo|milei/i.test(text);
}

async function fetchCronistaNews() {
  try {
    const parsed = await parser.parseURL(CRONISTA_RSS);
    return parsed.items
      .filter(item => item.link && isArgentinaArticle(item.link))
      .filter(item => isEconomyRelated(item))
      .map(item => ({
        title: item.title || '',
        summary: stripHtml(item.contentSnippet || item.description || item.summary || ''),
        link: item.link,
        pubDate: item.isoDate || item.pubDate || new Date().toISOString(),
        source: 'El Cronista',
      }));
  } catch (err) {
    console.warn('[Cronista]', err.message);
    return [];
  }
}

module.exports = { fetchCronistaNews };

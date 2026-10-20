const Parser = require('rss-parser');
const { filterAndRank, scoreItems } = require('./relevanceService');
const { dedupeNews } = require('./newsDedupService');
const { enrichNewsWithImages } = require('./newsImageService');
const { extractRssImage, normalizeRssImageUrl } = require('../utils/rssImage');
const { fetchInfobaeNews } = require('../providers/infobaeProvider');
const { fetchIprofesionalNews } = require('../providers/iprofesionalProvider');
const { fetchCronistaNews } = require('../providers/cronistaProvider');

const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'DashboardTC/1.0 (news aggregator)' },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['content:encoded', 'contentEncoded'],
    ],
  },
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
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

const RSS_FEEDS = [
  { url: 'https://eleconomista.com.ar/economia/feed/', source: 'El Economista' },
  { url: 'https://eleconomista.com.ar/finanzas/feed/', source: 'El Economista Finanzas' },
  // economia.xml de Ámbito suele timeout; el home responde y se filtra por tema abajo
  { url: 'https://www.ambito.com/rss/pages/home.xml', source: 'Ámbito Financiero', economyOnly: true },
  { url: 'https://www.lanacion.com.ar/arc/outboundfeeds/rss/category/economia/?outputType=xml', source: 'La Nación Economía' },
  { url: 'https://www.clarin.com/rss/economia/', source: 'Clarín Economía' },
  { url: 'https://www.perfil.com/feed/economia', source: 'Perfil Economía' },
  { url: 'https://www.cronista.com/arc/outboundfeeds/rss/category/economia-politica/?outputType=xml', source: 'El Cronista Economía' },
];

const ECONOMY_TITLE_RE = /d[oó]lar|bcra|fmi|bonos?|riesgo\s*pa[ií]s|reservas|inflaci[oó]n|export|import|super[aá]vit|d[eé]ficit|caputo|milei|merval|mep|ccl|mayorista|deuda|desembolso|tipo de cambio|cepo|crawling|liquidaci[oó]n|agro|soja|mercado|econom[ií]a|finanzas/i;

const CACHE_TTL_MS = 5 * 60 * 1000;
const NEWS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function parsePubDateMs(raw) {
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Solo noticias publicadas en las últimas 24 horas (fecha RSS/HTML válida). */
function filterLast24Hours(items) {
  const cutoff = Date.now() - NEWS_MAX_AGE_MS;
  return items.filter(item => {
    const t = parsePubDateMs(item.pubDate);
    return t != null && t >= cutoff;
  });
}

let cache = {
  data: null,
  fetchedAt: 0,
};

async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    let items = parsed.items.map(item => ({
      title: item.title || '',
      summary: stripHtml(item.contentSnippet || item.description || item.summary || ''),
      link: item.link || item.guid || '',
      pubDate: item.isoDate || item.pubDate || new Date().toISOString(),
      source: feed.source,
      rssImage: normalizeRssImageUrl(extractRssImage(item)),
    }));
    if (feed.economyOnly) {
      items = items.filter(i => ECONOMY_TITLE_RE.test(`${i.title} ${i.summary} ${i.link}`));
    }
    return items;
  } catch (err) {
    console.warn('[news-rss]', feed.source, err.message);
    return [];
  }
}

async function fetchAllNews() {
  const [rssResults, infobaeItems, iProItems, cronistaItems] = await Promise.all([
    Promise.allSettled(RSS_FEEDS.map(f => fetchFeed(f))),
    fetchInfobaeNews(),
    fetchIprofesionalNews(),
    fetchCronistaNews(),
  ]);

  const rssItems = rssResults.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  const allItems = [...rssItems, ...infobaeItems, ...iProItems, ...cronistaItems]
    .filter(item => item.link && item.title);
  const recentItems = filterLast24Hours(allItems);

  const scored = scoreItems(recentItems);
  const deduped = dedupeNews(scored);
  const ranked = filterAndRank(deduped, { minScore: 1, limit: 45 });
  return enrichNewsWithImages(ranked);
}

async function getNews() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { items: cache.data, cached: true };
  }

  try {
    const items = await fetchAllNews();
    cache = { data: items, fetchedAt: now };
    return { items, cached: false };
  } catch (err) {
    if (cache.data) {
      return { items: cache.data, cached: true, stale: true, error: err.message };
    }
    throw err;
  }
}

/**
 * Medios que suelen pedir suscripción / paywall al abrir la nota.
 * Se ocultan en el dashboard; el análisis interno (estimación / memoria) sigue usándolos.
 */
const DASHBOARD_HIDDEN_SOURCES = [
  /clar[ií]n/i,
  /iprofesional/i,
  /la naci[oó]n/i,
  /cronista/i,
];

function isDashboardHiddenSource(source = '') {
  return DASHBOARD_HIDDEN_SOURCES.some(re => re.test(source));
}

/** Noticias para mostrar en la UI (sin medios con paywall). */
async function getNewsForDashboard() {
  const news = await getNews();
  return {
    ...news,
    items: (news.items || []).filter(i => !isDashboardHiddenSource(i.source)),
  };
}

module.exports = { getNews, getNewsForDashboard, isDashboardHiddenSource };

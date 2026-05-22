const Parser = require('rss-parser');
const { filterAndRank, scoreItems } = require('./relevanceService');
const { dedupeNews } = require('./newsDedupService');
const { fetchInfobaeNews } = require('../providers/infobaeProvider');
const { fetchIprofesionalNews } = require('../providers/iprofesionalProvider');
const { fetchCronistaNews } = require('../providers/cronistaProvider');

const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'DashboardTC/1.0 (news aggregator)' },
});

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RSS_FEEDS = [
  { url: 'https://eleconomista.com.ar/economia/feed/', source: 'El Economista' },
  { url: 'https://eleconomista.com.ar/finanzas/feed/', source: 'El Economista Finanzas' },
  { url: 'https://www.ambito.com/rss/pages/economia.xml', source: 'Ámbito Financiero' },
  { url: 'https://www.ambito.com/rss/pages/finanzas.xml', source: 'Ámbito Finanzas' },
  { url: 'https://www.lanacion.com.ar/economia/feed/', source: 'La Nación Economía' },
];

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
    return parsed.items.map(item => ({
      title: item.title || '',
      summary: stripHtml(item.contentSnippet || item.description || item.summary || ''),
      link: item.link || item.guid || '',
      pubDate: item.isoDate || item.pubDate || new Date().toISOString(),
      source: feed.source,
    }));
  } catch {
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
  return filterAndRank(deduped, { minScore: 1, limit: 30 });
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

module.exports = { getNews };

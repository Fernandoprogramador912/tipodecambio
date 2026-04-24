const Parser = require('rss-parser');
const { filterAndRank } = require('./relevanceService');

const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'DashboardTC/1.0 (news aggregator)' },
  customFields: {
    item: ['media:content', 'content:encoded', 'description'],
  },
});

// Feeds RSS de economía y finanzas argentina
const RSS_FEEDS = [
  { url: 'https://www.infobae.com/feeds/rss/economia/', source: 'Infobae Economía' },
  { url: 'https://eleconomista.com.ar/economia/feed/', source: 'El Economista' },
  { url: 'https://eleconomista.com.ar/finanzas/feed/', source: 'El Economista Finanzas' },
  { url: 'https://www.ambito.com/rss/pages/economia.xml', source: 'Ámbito Financiero' },
  { url: 'https://www.ambito.com/rss/pages/finanzas.xml', source: 'Ámbito Finanzas' },
  { url: 'https://www.cronista.com/arc/outboundfeeds/rss/category/finanzas-y-mercados/', source: 'El Cronista' },
  { url: 'https://www.iprofesional.com/rss/finanzas.xml', source: 'iProfesional' },
  { url: 'https://www.lanacion.com.ar/economia/feed/', source: 'La Nación Economía' },
];

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

let cache = {
  data: null,
  fetchedAt: 0,
};

async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    return parsed.items.map(item => ({
      title: item.title || '',
      summary: item.contentSnippet || item.description || item.summary || '',
      link: item.link || item.guid || '',
      pubDate: item.isoDate || item.pubDate || new Date().toISOString(),
      source: feed.source,
    }));
  } catch {
    // Feed inaccesible — se ignora silenciosamente
    return [];
  }
}

async function fetchAllNews() {
  const results = await Promise.allSettled(RSS_FEEDS.map(f => fetchFeed(f)));

  const allItems = results.flatMap(r =>
    r.status === 'fulfilled' ? r.value : []
  );

  // Deduplicar por link
  const seen = new Set();
  const unique = allItems.filter(item => {
    if (!item.link || seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });

  return filterAndRank(unique, { minScore: 1, limit: 30 });
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

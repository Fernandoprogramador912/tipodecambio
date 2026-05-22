const Parser = require('rss-parser');

const IPRO_FEEDS = [
  { url: 'https://www.iprofesional.com/rss/economia', source: 'iProfesional Economía' },
  { url: 'https://www.iprofesional.com/rss/finanzas', source: 'iProfesional Finanzas' },
  { url: 'https://www.iprofesional.com/rss/impuestos', source: 'iProfesional Impuestos' },
];

const parser = new Parser({
  timeout: 12000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DashboardTC/1.0)' },
});

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLink(link) {
  if (!link) return '';
  try {
    const u = new URL(link.trim());
    u.hash = '';
    u.search = '';
    return u.toString();
  } catch {
    return String(link).trim();
  }
}

async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    return parsed.items
      .filter(item => item.link && item.title)
      .map(item => ({
        title: item.title || '',
        summary: stripHtml(item.contentSnippet || item.description || item.summary || ''),
        link: normalizeLink(item.link),
        pubDate: item.isoDate || item.pubDate || new Date().toISOString(),
        source: feed.source,
      }));
  } catch (err) {
    console.warn('[iPro]', feed.url, err.message);
    return [];
  }
}

async function fetchIprofesionalNews() {
  const batches = await Promise.all(IPRO_FEEDS.map(fetchFeed));
  const seen = new Set();
  const merged = [];

  for (const items of batches) {
    for (const item of items) {
      const key = normalizeLink(item.link);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}

module.exports = { fetchIprofesionalNews };

const axios = require('axios');

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; DashboardTC/1.0; +local)',
  Accept: 'text/html,application/xhtml+xml',
};

const SECTIONS = [
  { url: 'https://www.iprofesional.com/finanzas/', source: 'iProfesional Finanzas' },
  { url: 'https://www.iprofesional.com/economia/', source: 'iProfesional Economía' },
  { url: 'https://www.iprofesional.com/impuestos/', source: 'iProfesional Impuestos' },
];

const ARTICLE_RE = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/gi;
const TAG_RE = /<[^>]+>/g;

function cleanText(html) {
  return String(html || '').replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeArticleUrl(href) {
  if (!href) return '';
  if (href.startsWith('http')) return href.split('?')[0];
  return `https://www.iprofesional.com${href.startsWith('/') ? '' : '/'}${href}`.split('?')[0];
}

function parseSectionHtml(html, source) {
  const items = [];
  const seen = new Set();
  let match;

  while ((match = ARTICLE_RE.exec(html)) !== null) {
    const link = normalizeArticleUrl(match[1]);
    const title = cleanText(match[2]);
    if (!link || !title || title.length < 12) continue;
    if (!/\/(finanzas|economia|impuestos|negocios|politica|comex|management)\//i.test(link)) continue;
    if (seen.has(link)) continue;
    seen.add(link);

    items.push({
      title,
      summary: '',
      link,
      pubDate: new Date().toISOString(),
      source,
    });
  }

  return items;
}

async function fetchSection(section) {
  try {
    const res = await axios.get(section.url, {
      timeout: 12000,
      headers: FETCH_HEADERS,
      maxContentLength: 2_000_000,
    });
    return parseSectionHtml(String(res.data), section.source);
  } catch (err) {
    console.warn('[iPro]', section.url, err.message);
    return [];
  }
}

async function fetchIprofesionalNews() {
  const batches = await Promise.all(SECTIONS.map(fetchSection));
  const seen = new Set();
  const merged = [];

  for (const items of batches) {
    for (const item of items) {
      if (seen.has(item.link)) continue;
      seen.add(item.link);
      merged.push(item);
    }
  }

  return merged;
}

module.exports = { fetchIprofesionalNews };

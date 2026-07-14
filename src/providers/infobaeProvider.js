const Parser = require('rss-parser');

const INFOBAE_ECONOMIA_RSS =
  'https://www.infobae.com/arc/outboundfeeds/rss/category/economia/?outputType=xml';

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

function isArgentinaEconomyArticle(link) {
  try {
    const path = new URL(link).pathname.toLowerCase();
    if (!path.includes('/economia/')) return false;
    const intl = /^\/(mexico|colombia|espana|peru|chile|uruguay|usa|en|brasil)\//;
    return !intl.test(path);
  } catch {
    return false;
  }
}

async function fetchInfobaeNews() {
  try {
    const parsed = await parser.parseURL(INFOBAE_ECONOMIA_RSS);
    return parsed.items
      .filter(item => item.link && item.title && isArgentinaEconomyArticle(item.link))
      .map(item => ({
        title: item.title || '',
        summary: stripHtml(item.contentSnippet || item.description || item.summary || ''),
        link: item.link,
        pubDate: item.isoDate || item.pubDate || new Date().toISOString(),
        source: 'Infobae Economía',
      }));
  } catch (err) {
    console.warn('[Infobae]', err.message);
    return [];
  }
}

module.exports = { fetchInfobaeNews };

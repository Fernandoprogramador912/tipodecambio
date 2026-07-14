/**
 * Extrae URL de imagen destacada de un ítem RSS (enclosure / media / content).
 */
function extractRssImage(item) {
  const enclosure = item.enclosure;
  if (enclosure?.url) {
    const type = enclosure.type || '';
    const looksImage = !type
      || /^image\//i.test(type)
      || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(enclosure.url);
    if (looksImage) return enclosure.url;
  }

  const media = [].concat(item.mediaContent || [], item.mediaThumbnail || []);
  for (const m of media) {
    const url = m?.$?.url || m?.url;
    if (url) return url;
  }

  const html = item.contentEncoded || item['content:encoded'] || item.content || '';
  const matches = String(html).matchAll(/<img[^>]+src=["']([^"']+)["']/gi);
  for (const m of matches) {
    const url = m[1];
    if (/scorecardresearch|facebook\.com\/tr|doubleclick|googletag|1x1|pixel/i.test(url)) continue;
    if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(url) || /\/imagenes\//i.test(url) || /resizer\./i.test(url)) {
      return url;
    }
  }
  return null;
}

/** Mejora CDN de iProfesional (640 → 1280). */
function normalizeRssImageUrl(url) {
  if (!url) return null;
  return String(url)
    .replace(/&amp;/gi, '&')
    .replace(/resizer\.iproimg\.com\/unsafe\/\d+x\//i, 'resizer.iproimg.com/unsafe/1280x/')
    .trim();
}

module.exports = { extractRssImage, normalizeRssImageUrl };

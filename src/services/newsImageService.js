/**
 * Enriquecimiento de imágenes para noticias (Fase 1, sin CLIP).
 * Fuentes: og:image del artículo, Wikipedia (es/en), Wikimedia Commons, Pexels.
 * Filtra ≥ 800×450, dedupe por URL, rankea por tamaño + overlap de título.
 */

const axios = require('axios');

const MIN_W = Number(process.env.NEWS_IMAGE_MIN_WIDTH) || 800;
const MIN_H = Number(process.env.NEWS_IMAGE_MIN_HEIGHT) || 450;
const ENRICH_LIMIT = Number(process.env.NEWS_IMAGE_ENRICH_LIMIT) || 18;
const CONCURRENCY = Number(process.env.NEWS_IMAGE_CONCURRENCY) || 3;
const PEXELS_KEY = process.env.PEXELS_API_KEY || '';
const UA = 'DashboardTC/1.0 (news images; local aggregator)';

const http = axios.create({
  timeout: 7000,
  maxRedirects: 4,
  headers: { 'User-Agent': UA, Accept: '*/*' },
  validateStatus: s => s >= 200 && s < 400,
});

/** Cache por URL de artículo → imagen elegida (o null). */
const imageCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

function buildQuery(title = '') {
  const cleaned = String(title)
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Preferir tokens útiles (evitar "jornada", "hoy", etc.)
  const stop = new Set([
    'para', 'sobre', 'desde', 'hasta', 'como', 'esta', 'este', 'estos', 'estas',
    'jornada', 'financiera', 'hoy', 'ayer', 'tras', 'ante', 'dice', 'dijo',
    'segun', 'según', 'luego', 'entre', 'against', 'after', 'before',
  ]);
  const tokens = cleaned
    .split(/[\s,.:;¡!¿?()\[\]—–-]+/)
    .map(t => t.trim())
    .filter(t => t.length > 3 && !stop.has(t.toLowerCase()));
  return (tokens.slice(0, 6).join(' ') || cleaned).slice(0, 100);
}

function queryTokens(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9áéíóúñü]+/i)
    .filter(t => t.length > 3);
}

function tokenOverlapScore(query, haystack) {
  const q = queryTokens(query);
  if (!q.length) return 0;
  const h = String(haystack || '').toLowerCase();
  let hits = 0;
  for (const t of q) if (h.includes(t)) hits += 1;
  return hits / q.length;
}

function uniqueByUrl(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c?.url) continue;
    const url = decodeHtmlEntities(String(c.url).trim());
    if (!/^https?:\/\//i.test(url)) continue;
    const key = url.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, url });
  }
  return out;
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function rankCandidates(candidates, query) {
  return [...candidates]
    .map(c => {
      const area = (c.width || 0) * (c.height || 0);
      const overlap = tokenOverlapScore(query, `${c.title || ''} ${c.attribution || ''} ${c.source || ''}`);
      const score = Math.log10(Math.max(area, 1)) + overlap * 2;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);
}

/** Dimensiones desde primeros bytes (JPEG/PNG/WebP/GIF). */
function probeDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return { width, height };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 8) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        return { width, height };
      }
      i += 2 + len;
    }
  }
  // WebP (RIFF....WEBP)
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      const width = (b & 0x3fff) + 1;
      const height = ((b >> 14) & 0x3fff) + 1;
      return { width, height };
    }
    if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
      const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
      return { width, height };
    }
  }
  return null;
}

async function downloadAndValidate(candidate) {
  try {
    const res = await http.get(candidate.url, {
      responseType: 'arraybuffer',
      timeout: 8000,
      maxContentLength: 4 * 1024 * 1024,
      headers: {
        'User-Agent': UA,
        Accept: 'image/*,*/*',
        Referer: candidate.pageUrl || 'https://commons.wikimedia.org/',
      },
    });
    const buf = Buffer.from(res.data);
    const dims = probeDimensions(buf) || {
      width: candidate.width,
      height: candidate.height,
    };
    if (!dims?.width || !dims?.height) return null;
    if (dims.width < MIN_W || dims.height < MIN_H) return null;
    return {
      ...candidate,
      width: dims.width,
      height: dims.height,
      bytes: buf.length,
    };
  } catch {
    return null;
  }
}

async function filterByQuality(candidates, { allowUnverified = false } = {}) {
  const out = [];
  const deferred = [];
  for (const c of candidates) {
    // Banderas/SVG de Commons suelen ser mal match para portadas de notas
    if (/\.svg(\?|$)/i.test(c.url || '') || /Flag_of_/i.test(c.url || '') || /Flag_of_/i.test(c.title || '')) {
      continue;
    }
    if (c.width && c.height && (c.width < MIN_W || c.height < MIN_H)) continue;

    const trusted = ['wikipedia:es', 'wikipedia:en', 'wikimedia-commons', 'pexels'].includes(c.source);
    if (trusted && c.width >= MIN_W && c.height >= MIN_H) {
      out.push(c);
    } else {
      const ok = await downloadAndValidate(c);
      if (ok) out.push(ok);
      else if (allowUnverified && (c.source === 'og:image' || c.source === 'rss')) {
        deferred.push({
          ...c,
          width: c.width || 1200,
          height: c.height || 675,
          unverified: true,
        });
      }
    }
    if (out.length >= 6) break;
  }
  if (out.length) return out;
  return deferred.slice(0, 2);
}

function fallbackQueries(title) {
  const lower = String(title || '').toLowerCase();
  const seeds = [
    ['banco central', 'Banco Central Argentina'],
    ['reservas', 'Reservas internacionales Argentina'],
    ['inflacion', 'Inflación Argentina'],
    ['inflación', 'Inflación Argentina'],
    ['petroleo', 'Petróleo'],
    ['petróleo', 'Petróleo'],
    ['bonos', 'Bonos soberanos Argentina'],
    ['acciones', 'Bolsa de Comercio de Buenos Aires'],
    ['dolar', 'Dólar estadounidense'],
    ['dólar', 'Dólar estadounidense'],
    ['riesgo pais', 'Riesgo país'],
    ['riesgo país', 'Riesgo país'],
    ['milei', 'Javier Milei'],
    ['brecha', 'Tipo de cambio Argentina'],
    ['mep', 'Dólar MEP'],
    ['futuros', 'Futuros de dólar'],
  ];
  const hits = [];
  for (const [needle, q] of seeds) {
    if (lower.includes(needle)) hits.push(q);
  }
  return hits.slice(0, 2);
}

async function fetchOgImage(articleUrl) {
  if (!articleUrl || !/^https?:\/\//i.test(articleUrl)) return [];
  try {
    const res = await http.get(articleUrl, {
      timeout: 6000,
      maxContentLength: 800_000,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
      },
      responseType: 'text',
      transformResponse: [d => d],
    });
    const html = String(res.data || '');
    const metas = [];
    const re = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image|og:image:url)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html))) {
      const tag = m[0];
      const content = tag.match(/content=["']([^"']+)["']/i);
      if (content?.[1]) metas.push(content[1].trim());
    }
    // También link rel=image_src
    const linkImg = html.match(/<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i);
    if (linkImg?.[1]) metas.push(linkImg[1].trim());

    return uniqueByUrl(metas.map(url => ({
      url: url.startsWith('//') ? `https:${url}` : url,
      source: 'og:image',
      license: 'unknown',
      attribution: null,
      title: null,
      pageUrl: articleUrl,
    }))).slice(0, 2);
  } catch {
    return [];
  }
}

async function wikiSearchLang(lang, query) {
  try {
    const search = await http.get(`https://${lang}.wikipedia.org/w/api.php`, {
      params: {
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: 3,
        format: 'json',
        origin: '*',
      },
    });
    const hits = search.data?.query?.search || [];
    if (!hits.length) return [];

    const titles = hits.map(h => h.title).join('|');
    const pages = await http.get(`https://${lang}.wikipedia.org/w/api.php`, {
      params: {
        action: 'query',
        titles,
        prop: 'pageimages|info',
        pithumbsize: 1600,
        inprop: 'url',
        format: 'json',
        origin: '*',
      },
    });
    const out = [];
    const map = pages.data?.query?.pages || {};
    for (const page of Object.values(map)) {
      const thumb = page.thumbnail;
      if (!thumb?.source) continue;
      out.push({
        url: thumb.source.replace(/\/\d+px-/, '/1280px-'),
        width: Math.max(thumb.width || 0, 1280),
        height: thumb.height
          ? Math.round((thumb.height / Math.max(thumb.width, 1)) * 1280)
          : 720,
        source: `wikipedia:${lang}`,
        license: 'CC-BY-SA',
        attribution: `Wikipedia (${lang}) — ${page.title}`,
        title: page.title,
        pageUrl: page.fullurl || `https://${lang}.wikipedia.org/?curid=${page.pageid}`,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchWikipedia(query) {
  const [es, en] = await Promise.all([
    wikiSearchLang('es', query),
    wikiSearchLang('en', query),
  ]);
  return [...es, ...en];
}

async function fetchCommons(query) {
  try {
    const res = await http.get('https://commons.wikimedia.org/w/api.php', {
      params: {
        action: 'query',
        generator: 'search',
        gsrsearch: query,
        gsrnamespace: 6,
        gsrlimit: 5,
        prop: 'imageinfo',
        iiprop: 'url|size|extmetadata',
        iiurlwidth: 1280,
        format: 'json',
        origin: '*',
      },
    });
    const pages = res.data?.query?.pages || {};
    const out = [];
    for (const page of Object.values(pages)) {
      const info = page.imageinfo?.[0];
      if (!info?.url && !info?.thumburl) continue;
      const meta = info.extmetadata || {};
      const license = meta.LicenseShortName?.value || meta.License?.value || 'see Commons';
      const artist = meta.Artist?.value ? String(meta.Artist.value).replace(/<[^>]+>/g, '') : null;
      out.push({
        url: info.thumburl || info.url,
        width: info.thumbwidth || info.width,
        height: info.thumbheight || info.height,
        source: 'wikimedia-commons',
        license,
        attribution: artist || 'Wikimedia Commons',
        title: page.title,
        pageUrl: info.descriptionurl || info.url,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchPexels(query) {
  if (!PEXELS_KEY) return [];
  try {
    const res = await http.get('https://api.pexels.com/v1/search', {
      params: { query, per_page: 5, locale: 'es-ES' },
      headers: { Authorization: PEXELS_KEY },
    });
    return (res.data?.photos || []).map(p => ({
      url: p.src?.large2x || p.src?.large || p.src?.original,
      width: p.width,
      height: p.height,
      source: 'pexels',
      license: 'Pexels License (libre, sin atribución obligatoria)',
      attribution: p.photographer ? `${p.photographer} / Pexels` : 'Pexels',
      title: p.alt || query,
      pageUrl: p.url,
    }));
  } catch {
    return [];
  }
}

async function pickImageForItem(item) {
  const cacheKey = item.link;
  const cached = imageCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.image;
  }

  const query = buildQuery(item.title);
  const queries = [query, ...fallbackQueries(item.title)];
  const tryBatches = [];

  if (item.rssImage) {
    tryBatches.push(async () => [{
      url: item.rssImage,
      source: 'rss',
      license: 'unknown',
      attribution: item.source || null,
      title: item.title,
      pageUrl: item.link,
      width: item.rssImageWidth,
      height: item.rssImageHeight,
    }]);
  }
  tryBatches.push(() => fetchOgImage(item.link));

  for (const q of queries) {
    tryBatches.push(() => wikiSearchLang('es', q));
    tryBatches.push(() => fetchCommons(q));
  }
  tryBatches.push(() => wikiSearchLang('en', query));
  tryBatches.push(() => fetchPexels(query));

  for (const getBatch of tryBatches) {
    let batch = [];
    try {
      batch = await getBatch();
    } catch {
      continue;
    }
    if (!batch.length) continue;
    const ranked = rankCandidates(uniqueByUrl(batch), query);
    const validated = await filterByQuality(ranked, { allowUnverified: true });
    const best = rankCandidates(validated, query)[0];
    if (best) {
      imageCache.set(cacheKey, { at: Date.now(), image: best });
      return best;
    }
  }

  imageCache.set(cacheKey, { at: Date.now(), image: null });
  return null;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function dimsFromUrl(url) {
  const m = String(url || '').match(/\/(\d{3,4})x(\d{3,4})\//);
  if (m) return { width: Number(m[1]), height: Number(m[2]) };
  if (/iproimg\.com|assets\.iprofesional\.com/i.test(url || '')) {
    return { width: 1280, height: 720 };
  }
  if (/media\.ambito\.com/i.test(url || '')) {
    return { width: 1200, height: 675 };
  }
  return {};
}

function imageFromRss(item) {
  if (!item?.rssImage) return null;
  const dims = dimsFromUrl(item.rssImage);
  return {
    url: item.rssImage,
    width: item.rssImageWidth || dims.width || 1200,
    height: item.rssImageHeight || dims.height || 675,
    source: 'rss',
    license: 'unknown',
    attribution: item.source || null,
    title: item.title || null,
    score: 3,
  };
}

/**
 * Adjunta `image` a cada ítem.
 * 1) RSS enclosure/media para TODAS las notas (rápido, sin scraping).
 * 2) Wikipedia/og/etc. solo para las primeras sin imagen (presupuesto limitado).
 */
async function enrichNewsWithImages(items = []) {
  if (!items.length) return items;

  const seeded = items.map(item => {
    const rssImg = imageFromRss(item);
    return rssImg ? { ...item, image: rssImg } : { ...item, image: null };
  });

  const needEnrich = [];
  seeded.forEach((item, index) => {
    if (!item.image) needEnrich.push({ item, index });
  });

  const queue = needEnrich.slice(0, ENRICH_LIMIT);
  const budgetMs = Number(process.env.NEWS_IMAGE_BUDGET_MS) || 18_000;

  const work = mapPool(queue, CONCURRENCY, async ({ item, index }) => {
    try {
      const image = await pickImageForItem(item);
      return { index, image };
    } catch (err) {
      console.warn('[news-image]', item.link, err.message);
      return { index, image: null };
    }
  });

  const results = await Promise.race([
    work,
    new Promise(resolve => setTimeout(() => resolve(null), budgetMs)),
  ]);

  if (results) {
    for (const r of results) {
      if (!r?.image) continue;
      seeded[r.index] = {
        ...seeded[r.index],
        image: {
          url: r.image.url,
          width: r.image.width,
          height: r.image.height,
          source: r.image.source,
          license: r.image.license,
          attribution: r.image.attribution,
          title: r.image.title,
          score: r.image.score,
        },
      };
    }
  } else {
    console.warn('[news-image] presupuesto agotado; se mantienen sólo imágenes RSS');
  }

  return seeded;
}

module.exports = {
  enrichNewsWithImages,
  pickImageForItem,
  MIN_W,
  MIN_H,
};

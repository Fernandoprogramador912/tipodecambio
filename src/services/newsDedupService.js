/**
 * Elimina noticias duplicadas (mismo link) y muy similares (mismo titular reescrito).
 */

const STOPWORDS = new Set([
  'a', 'al', 'ante', 'bajo', 'con', 'contra', 'de', 'del', 'desde', 'durante', 'e', 'el', 'en',
  'entre', 'hacia', 'hasta', 'la', 'las', 'le', 'les', 'lo', 'los', 'mas', 'más', 'me', 'mi',
  'o', 'para', 'pero', 'por', 'que', 'qué', 'se', 'sin', 'sobre', 'su', 'sus', 'te', 'tu', 'un',
  'una', 'uno', 'y', 'ya', 'es', 'son', 'ser', 'fue', 'como', 'tras', 'este', 'esta', 'estos',
  'estas', 'ese', 'esa', 'eso', 'año', 'anos', 'años',
]);

function stripAccents(str) {
  return String(str || '').normalize('NFD').replace(/\p{M}/gu, '');
}

function normalizeLink(link) {
  if (!link) return '';
  try {
    const u = new URL(link.trim());
    u.hash = '';
    u.search = '';
    const path = u.pathname.replace(/\/$/, '').toLowerCase();
    return `${u.hostname}${path}`;
  } catch {
    return String(link).trim().toLowerCase();
  }
}

function normalizeTitle(title) {
  return stripAccents(title)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(title) {
  const norm = normalizeTitle(title);
  if (!norm) return [];
  return norm
    .split(' ')
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

function areTitlesSimilar(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.length || !tb.length) return false;

  const jac = jaccard(ta, tb);
  if (jac >= 0.58) return true;

  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na.length >= 40 && nb.length >= 40) {
    if (na.includes(nb) || nb.includes(na)) return true;
  }

  const shorter = ta.length < tb.length ? ta : tb;
  const longer = ta.length < tb.length ? tb : ta;
  const longerSet = new Set(longer);
  const overlap = shorter.filter(t => longerSet.has(t)).length;
  if (shorter.length >= 5 && overlap / shorter.length >= 0.85) return true;

  return false;
}

function areItemsSimilar(a, b) {
  const linkA = normalizeLink(a.link);
  const linkB = normalizeLink(b.link);
  if (linkA && linkB && linkA === linkB) return true;

  if (areTitlesSimilar(a.title, b.title)) return true;

  if (a.summary && b.summary) {
    const sa = titleTokens(a.summary).slice(0, 24);
    const sb = titleTokens(b.summary).slice(0, 24);
    if (sa.length >= 8 && sb.length >= 8 && jaccard(sa, sb) >= 0.72) return true;
  }

  return false;
}

/** Deduplica por URL normalizada. */
function dedupeByLink(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = normalizeLink(item.link);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Quita titulares muy parecidos; conserva el de mayor score o más reciente.
 */
function dedupeSimilar(items) {
  const sorted = [...items].sort((a, b) => {
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return new Date(b.pubDate) - new Date(a.pubDate);
  });

  const kept = [];
  for (const item of sorted) {
    if (kept.some(k => areItemsSimilar(item, k))) continue;
    kept.push(item);
  }

  return kept;
}

function dedupeNews(items) {
  return dedupeSimilar(dedupeByLink(items));
}

module.exports = {
  dedupeNews,
  dedupeByLink,
  dedupeSimilar,
  normalizeLink,
  areTitlesSimilar,
};

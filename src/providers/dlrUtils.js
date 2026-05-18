const MONTH_ABBR = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

/** Contrato DLR activo (mismo que A3 / futuros financieros una vez resuelto). */
let activeSpotSymbol = null;

function nearestContracts(count = 6) {
  const contracts = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const abbr = MONTH_ABBR[d.getMonth()];
    const yy = String(d.getFullYear()).slice(-2);
    contracts.push(`DLR/${abbr}${yy}`);
  }
  return contracts;
}

/** Instrumento del Últ en el encabezado "Dólar USA" de A3 (no es DLR/MAY26). */
const DEFAULT_MAYORISTA_SYMBOL = 'DLR/SPOT';

function getMayoristaSymbol() {
  return (
    process.env.A3_MAYORISTA_SYMBOL?.trim()
    || process.env.FUTURES_SPOT_SYMBOL?.trim()
    || DEFAULT_MAYORISTA_SYMBOL
  );
}

function getPinnedSpotSymbol() {
  return getMayoristaSymbol();
}

function getActiveSpotSymbol() {
  return getPinnedSpotSymbol() || activeSpotSymbol || DEFAULT_MAYORISTA_SYMBOL;
}

function setActiveSpotSymbol(symbol) {
  if (symbol) activeSpotSymbol = symbol;
}

/** Lista para suscripción WS: contrato pinneado + próximos vencimientos. */
function getWatchList() {
  const mayorista = getMayoristaSymbol();
  const extra = ['DOLAR/MTR'].filter(s => s !== mayorista);
  const base = nearestContracts(8);
  return [mayorista, ...extra, ...base.filter(s => s !== mayorista && !extra.includes(s))];
}

/** Orden cronológico por vencimiento (como la grilla A3), no alfabético. */
function sortDlrContracts(symbols) {
  const monthIndex = Object.fromEntries(MONTH_ABBR.map((m, i) => [m, i]));

  return symbols.slice().sort((a, b) => {
    const ma = a.match(/^DLR\/([A-Z]{3})(\d{2})$/);
    const mb = b.match(/^DLR\/([A-Z]{3})(\d{2})$/);
    if (!ma || !mb) return a.localeCompare(b);
    const ya = 2000 + parseInt(ma[2], 10);
    const yb = 2000 + parseInt(mb[2], 10);
    return (ya * 12 + monthIndex[ma[1]]) - (yb * 12 + monthIndex[mb[1]]);
  });
}

/** Último operado (LA) — no usa ajuste (SE) ni bid/ask. */
function pickLastOperated(md) {
  if (!md) return null;
  return md.LA?.price ?? null;
}

module.exports = {
  MONTH_ABBR,
  nearestContracts,
  getMayoristaSymbol,
  getWatchList,
  getActiveSpotSymbol,
  getPinnedSpotSymbol,
  setActiveSpotSymbol,
  sortDlrContracts,
  pickLastOperated,
  DEFAULT_MAYORISTA_SYMBOL,
};

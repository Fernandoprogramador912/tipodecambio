const tcHistory = require('./tcIntradayHistoryService');

function record(venta, compra, ts) {
  if (venta == null || Number.isNaN(Number(venta))) return;
  tcHistory.addPoint(venta, compra, ts).catch(err => {
    console.warn('[tc-history]', err.message);
  });
}

async function getTodayHistory() {
  const day = await tcHistory.getDay(tcHistory.todayART());
  return day.points || [];
}

module.exports = { record, getTodayHistory };

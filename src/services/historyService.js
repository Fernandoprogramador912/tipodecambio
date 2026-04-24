// El historial intradiario se maneja en el frontend (localStorage).
// Este módulo queda como stub para mantener compatibilidad con exchangeService.

function record() { /* no-op en serverless */ }
function getTodayHistory() { return []; }

module.exports = { record, getTodayHistory };

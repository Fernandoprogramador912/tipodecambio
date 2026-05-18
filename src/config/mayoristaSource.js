/**
 * NOTA INTERNA — no exponer en la UI.
 *
 * La cotización "mayorista" en pantalla = Últ del encabezado "Dólar USA" en A3,
 * instrumento DLR/SPOT (security rx_DDF_DLR_SPOT), NO el futuro DLR/MAY26.
 *
 * La web A3 lo obtiene por WebSocket Matriz:
 *   topic md.rx_DDF_DLR_SPOT → tick con lst ~1397
 *
 * Widget "DLR MTR" (barra superior) usa otro instrumento: DOLAR/MTR (rx_DDA_DOLAR_MTR).
 */

module.exports = {
  INTERNAL_MAYORISTA_NOTE:
    'UI mayorista = A3 encabezado Dólar USA (DLR/SPOT vía a3MatrizWsProvider), ver exchangeService',
};

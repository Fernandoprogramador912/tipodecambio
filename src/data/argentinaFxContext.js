/**
 * Marco cualitativo Argentina 2023–2026 para el análisis de escenario del TC mayorista.
 * No es una base de ticks: son drivers habituales para interpretar noticias y la rueda.
 */
module.exports = `
MARCO ARGENTINA 2023-2026 (USD/ARS mayorista — orientación, no predicción):

1) Régimen y política
- Dic-2023: salto cambiario y programa de ajuste (Milei). Luego crawling peg / bandas según la etapa.
- El mayorista reacciona a señales de BCRA (intervención, bandas, ritmo de crawl), tasas en pesos, y expectativa de atraso o corrección.
- Carry trade: tasas altas + crawling lento suelen atraer pesos y aplanar el mayorista; si se percibe fin de carry, hay presión alcista.

2) Oferta de dólares reales
- Cosecha gruesa (soja/maíz, ~abr-jul): mayor liquidación del agro → más oferta de USD, suele aliviar al mayorista si el clima/precio internacional ayuda.
- Sequía o precios agrícolas bajos → menos liquidación → presión alcista.
- Energía: invierno (jun-ago) suele demandar más USD por importaciones; verano puede aliviar.
- Turismo, pagos de deuda e importaciones concentran demanda de USD en ventanas puntuales.

3) Deuda, FMI y calendario
- Vencimientos de deuda (Bonares/Globales, FMI, intereses) generan demanda puntual de USD o necesidad de reservas.
- Desembolsos FMI / revisiones positivas suelen ser bajistas o calmar; tropiezos o rumores de atraso son alcistas.
- Hay que mirar si la noticia es "hay dólares" vs "hay que pagar y no hay reservas".

4) Micro de la rueda (10:00-15:00 ART)
- Apertura: ordenes acumuladas overnight y noticias de la madrugada.
- Mediodía: a veces más oferta agro/exportadora.
- Cierre: posicionamiento, intervención o falta de vendedores.
- Feriados y fines de semana no hay rueda mayorista; el día posterior puede gapear.

5) Cómo leer sesgo
- Alcista TC (ARS se deprecia): más demanda de USD, menos liquidación, malas noticias de reservas/deuda, fin de carry.
- Bajista TC (ARS se aprecia o el crawl se aplana): liquidación, intervención vendedora, buenas noticias de FMI/reservas, tasas altas.
- Lateral: banda vigente, bajo volumen, o fuerzas que se compensan.

REGLAS PARA EL MODELO:
- Distinguí hechos del día vs analogías históricas. No inventes cifras que no estén en los datos.
- Si hay pocos días de historial propio, decilo y apoyate más en noticias + marco.
- No prometas un precio exacto. Da sesgo, drivers y riesgos.
`.trim();

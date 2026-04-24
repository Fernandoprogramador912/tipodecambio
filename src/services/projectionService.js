/**
 * Servicio de proyección intradiaria USD/ARS.
 *
 * Señales utilizadas:
 *  1. Futuros DLR (Matba-Rofex): ajuste implícito diario = (futuro/spot - 1) / días_hábiles
 *  2. Día de la semana: efecto estadístico (viernes = presión alcista por cobertura)
 *  3. Fase de la rueda: apertura / media / pre-cierre / cierre
 *
 * Score total → dirección + rango estimado de cierre.
 * No constituye asesoramiento financiero.
 */

const MONTH_MAP = {
  ENE:0, FEB:1, MAR:2, ABR:3, MAY:4, JUN:5,
  JUL:6, AGO:7, SEP:8, OCT:9, NOV:10, DIC:11,
};

const DAY_NAMES = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];

// ── Helpers de fecha ──────────────────────────────────────────────────────────

function artNow() {
  // Hora actual en Argentina (UTC-3)
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

function parseContractExpiry(symbol) {
  const match = symbol.match(/^DLR\/([A-Z]{3})(\d{2})$/);
  if (!match) return null;
  const month = MONTH_MAP[match[1]];
  if (month === undefined) return null;
  const year = 2000 + parseInt(match[2]);
  // Último día del mes
  const d = new Date(Date.UTC(year, month + 1, 0));
  // Retroceder al último día hábil (lunes–viernes)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d;
}

function businessDaysUntil(targetDate) {
  const today = artNow();
  today.setUTCHours(0, 0, 0, 0);
  const target = new Date(targetDate);
  target.setUTCHours(0, 0, 0, 0);
  if (target < today) return 0;
  let count = 0;
  const cur = new Date(today);
  while (cur <= target) {
    const d = cur.getUTCDay();
    if (d !== 0 && d !== 6) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return Math.max(count, 1);
}

// ── Señales ───────────────────────────────────────────────────────────────────

function getFuturesSignal(spot, contracts) {
  const candidates = contracts
    .filter(c => c.lastPrice != null && c.lastPrice > 0)
    .map(c => {
      const expiry = parseContractExpiry(c.symbol);
      const days   = expiry ? businessDaysUntil(expiry) : null;
      return { ...c, expiry, days };
    })
    .filter(c => c.days !== null && c.days > 0)
    .sort((a, b) => a.days - b.days);

  if (candidates.length === 0) return null;

  const nearest = candidates[0];
  const impliedDailyPct = ((nearest.lastPrice / spot) - 1) / nearest.days * 100;

  // Score: escala proporcional al movimiento implícito diario
  let score = 0;
  if      (impliedDailyPct >  0.12) score =  2.5;
  else if (impliedDailyPct >  0.06) score =  1.5;
  else if (impliedDailyPct >  0.02) score =  0.8;
  else if (impliedDailyPct > -0.02) score =  0;
  else if (impliedDailyPct > -0.06) score = -0.8;
  else if (impliedDailyPct > -0.12) score = -1.5;
  else                               score = -2.5;

  return {
    symbol: nearest.symbol,
    futurePrice: nearest.lastPrice,
    daysToExpiry: nearest.days,
    impliedDailyPct: +impliedDailyPct.toFixed(4),
    score,
  };
}

function getDayOfWeekSignal() {
  const art = artNow();
  const dow = art.getUTCDay(); // 0=Dom, 1=Lun, ..., 5=Vie

  let score = 0;
  let desc  = '';

  if (dow === 5) {
    score = 1;
    desc  = 'Viernes: operadores buscan cobertura ante el fin de semana, incrementa demanda de divisas';
  } else if (dow === 1) {
    score = -0.2;
    desc  = 'Lunes: apertura de semana, presión generalmente contenida';
  } else if (dow === 4) {
    score = 0.2;
    desc  = 'Jueves: leve anticipación al comportamiento de viernes';
  } else {
    score = 0;
    desc  = `${DAY_NAMES[dow]}: sin efecto estacional significativo`;
  }

  return { dow, dayName: DAY_NAMES[dow], score, description: desc };
}

function getSessionPhase() {
  const art  = artNow();
  const hour = art.getUTCHours() + art.getUTCMinutes() / 60;

  if (hour < 10)    return { phase: 'pre-rueda',   label: 'Pre-rueda',       desc: 'Rueda aún no inició' };
  if (hour < 11)    return { phase: 'apertura',    label: 'Apertura',        desc: 'Precio inicial en formación — mayor volatilidad posible' };
  if (hour < 13.5)  return { phase: 'media',       label: 'Sesión media',    desc: 'Mercado en equilibrio operativo' };
  if (hour < 14.5)  return { phase: 'pre-cierre',  label: 'Pre-cierre',      desc: 'Operadores posicionándose hacia el cierre' };
  if (hour <= 15)   return { phase: 'cierre',      label: 'Cierre de rueda', desc: 'Últimos minutos — posible aceleración del movimiento del día' };
  return             { phase: 'post-rueda',         label: 'Rueda cerrada',   desc: 'Fuera de horario de operaciones' };
}

// ── Dirección y rango ─────────────────────────────────────────────────────────

function scoreToDirection(score) {
  if (score >= 2.5)  return { label: 'Alcista fuerte',    tag: 'muy_alto', arrow: '▲▲' };
  if (score >= 1.2)  return { label: 'Alcista moderado',  tag: 'alto',     arrow: '▲'  };
  if (score >= 0.4)  return { label: 'Levemente alcista', tag: 'medio',    arrow: '↗'  };
  if (score > -0.4)  return { label: 'Neutro / estable',  tag: 'neutro',   arrow: '→'  };
  if (score > -1.2)  return { label: 'Levemente bajista', tag: 'medio',    arrow: '↘'  };
  if (score > -2.5)  return { label: 'Bajista moderado',  tag: 'alto',     arrow: '▼'  };
  return               { label: 'Bajista fuerte',         tag: 'muy_alto', arrow: '▼▼' };
}

function getRecommendation(direction, session, dowSignal) {
  const tag = direction.tag;
  const phase = session.phase;
  const isFriday = dowSignal.dow === 5;

  if (tag === 'muy_alto' || tag === 'alto') {
    if (direction.arrow.includes('▲')) {
      // Alcista
      if (phase === 'apertura' || phase === 'media') {
        return isFriday
          ? 'Presión alcista típica de viernes amplificada por la señal de futuros. Si necesitás cerrar cambio hoy, conviene hacerlo en la primera mitad de la rueda, antes de la presión del cierre.'
          : 'Señales apuntan a suba durante el día. Si necesitás cerrar cambio, hacerlo temprano puede ser más conveniente que esperar al cierre.';
      }
      return 'Ya en zona de cierre con presión alcista. Si no operaste aún, evaluá si podés esperar a la próxima rueda para ver si el movimiento se modera.';
    } else {
      // Bajista
      return 'Señales sugieren presión bajista. Si podés esperar, el cierre o la próxima rueda podrían ofrecer una mejor cotización para cerrar cambio.';
    }
  }

  if (tag === 'medio') {
    if (direction.arrow.includes('↗')) {
      return isFriday
        ? 'Leve sesgo alcista reforzado por el efecto viernes. Sin urgencia, pero operar en la primera mitad de la rueda puede ser prudente.'
        : 'Leve presión alcista. El tipo de cambio podría subir marginalmente durante el día. Sin señal fuerte para esperar o apurar.';
    }
    return 'Leve sesgo bajista o de estabilización. Si podés, esperar podría ser levemente más conveniente.';
  }

  return 'Sin señal clara de dirección. El tipo de cambio debería mantenerse estable durante la rueda. El momento de cerrar cambio no impacta significativamente.';
}

// ── Función principal ─────────────────────────────────────────────────────────

function calculateProjection(spot, contracts) {
  const futuresSignal = getFuturesSignal(spot, contracts);
  const dowSignal     = getDayOfWeekSignal();
  const session       = getSessionPhase();

  let totalScore = 0;
  const signals  = [];

  // Señal 1: Futuros
  if (futuresSignal) {
    totalScore += futuresSignal.score;
    const pct = futuresSignal.impliedDailyPct;
    signals.push({
      tipo: 'futuros',
      icono: pct >= 0.02 ? '▲' : pct <= -0.02 ? '▼' : '→',
      descripcion: `${futuresSignal.symbol} → $${futuresSignal.futurePrice.toLocaleString('es-AR', { minimumFractionDigits: 0 })} | ajuste implícito ${pct >= 0 ? '+' : ''}${pct.toFixed(3)}%/día (${futuresSignal.daysToExpiry} días hábiles al vencimiento)`,
      impacto: futuresSignal.score > 0.3 ? 'alcista' : futuresSignal.score < -0.3 ? 'bajista' : 'neutro',
    });
  } else {
    signals.push({
      tipo: 'futuros',
      icono: '—',
      descripcion: 'Futuros sin precio disponible (rueda cerrada o sin operaciones en el contrato más próximo)',
      impacto: 'neutro',
    });
  }

  // Señal 2: Día de la semana
  totalScore += dowSignal.score;
  signals.push({
    tipo: 'dia_semana',
    icono: dowSignal.score > 0.1 ? '▲' : dowSignal.score < -0.1 ? '▼' : '→',
    descripcion: dowSignal.description,
    impacto: dowSignal.score > 0.1 ? 'alcista' : dowSignal.score < -0.1 ? 'bajista' : 'neutro',
  });

  // Señal 3: Fase de la rueda
  signals.push({
    tipo: 'sesion',
    icono: '⏱',
    descripcion: `${session.label}: ${session.desc}`,
    impacto: 'neutro',
  });

  const direction = scoreToDirection(totalScore);

  // Rango estimado
  const impliedMove = futuresSignal ? futuresSignal.impliedDailyPct / 100 : 0;
  const dowAdj      = dowSignal.score * 0.0002;
  const totalMove   = impliedMove + dowAdj;
  const uncertainty = 0.0012; // ±0.12% banda de incertidumbre

  const estimated = spot * (1 + totalMove);
  const rangeMin  = Math.round(spot * (1 + totalMove - uncertainty));
  const rangeMax  = Math.round(spot * (1 + totalMove + uncertainty));

  return {
    spot,
    direction,
    totalScore: +totalScore.toFixed(2),
    estimated:  +estimated.toFixed(2),
    rangeMin,
    rangeMax,
    variacionEstimada: totalMove >= 0
      ? `+${(totalMove * 100).toFixed(3)}%`
      : `${(totalMove * 100).toFixed(3)}%`,
    signals,
    session,
    dayName:       dowSignal.dayName,
    recommendation: getRecommendation(direction, session, dowSignal),
    disclaimer: 'Proyección orientativa basada en señales de mercado. No constituye asesoramiento financiero.',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { calculateProjection };

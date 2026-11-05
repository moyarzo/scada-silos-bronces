// ===== KPI: CONSUMO, RECEPCIONES Y USO POR SILO (desde el historial) =====
//
// Fuente: historial de % de llenado por silo cada 5 min (siloHistoryData / nitrato_siloHistoryData).
// Cada silo convierte su % a toneladas con su propio modelo (Matriz o Nitrato).
//
// Filtro de ruido del radar (validado con simulación: error < 1.5 % con ruido de hasta ±6 cm y picos):
//   1) Mediana móvil de 7 muestras (35 min): elimina picos sin desplazar los cambios reales.
//   2) Histéresis con umbral adaptativo por silo y por día: max(KPI_UMBRAL_TON, 3·σ), donde σ es
//      el ruido medido ese día (desviación robusta entre la lectura y la mediana).
//   Un cambio solo se cuenta cuando la masa se aleja más que el umbral del último valor contado:
//   las oscilaciones no se suman como consumo ni recepción, y un descenso lento sí se acumula.
//
// Bajas = consumo · subidas = recepción. Una recarga es un tramo continuo de subidas
// (se cierra con un consumo o tras 30 min sin subir) que suma al menos KPI_RECARGA_MIN_TON (1 t).
// Un % exactamente 0 se trata como "sin dato" (silo sin señal o servidor recién reiniciado).

const THRESHOLD_TON    = Number(process.env.KPI_UMBRAL_TON || 0.3);
const RECHARGE_MIN_TON = Number(process.env.KPI_RECARGA_MIN_TON || 1);
const RECHARGE_GAP     = 6;   // bloques de 5 min sin subir que cierran una recarga (30 min)

const MEDIAN_WINDOW = 7;

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function analyzeDay(dayArr, toTon, startRef) {
  const sorted = (dayArr || []).slice().sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const raw = [];
  sorted.forEach(p => {
    const pct = Number(p.value);
    if (pct > 0 && isFinite(pct)) raw.push(toTon(pct));   // % exactamente 0 = sin dato
  });

  // 1) Mediana móvil
  const half = MEDIAN_WINDOW >> 1;
  const smooth = raw.map((v, i) => median(raw.slice(Math.max(0, i - half), i + half + 1)));

  // 2) Umbral adaptativo según el ruido del día
  const sigma = raw.length ? 1.4826 * median(raw.map((v, i) => Math.abs(v - smooth[i]))) : 0;
  const threshold = Math.max(THRESHOLD_TON, 3 * sigma);

  let ref = startRef;
  let consumo = 0, recepcion = 0, recargas = 0;
  let event = 0, idle = 0, inEvent = false;

  function closeEvent() {
    if (inEvent && event >= RECHARGE_MIN_TON) recargas++;
    inEvent = false; event = 0; idle = 0;
  }

  smooth.forEach(ton => {
    if (ref == null) { ref = ton; return; }
    const d = ton - ref;
    if (d <= -threshold) {
      consumo += -d; ref = ton;
      closeEvent();
    } else if (d >= threshold) {
      recepcion += d; ref = ton;
      inEvent = true; event += d; idle = 0;
    } else if (inEvent && ++idle >= RECHARGE_GAP) {
      closeEvent();
    }
  });
  closeEvent();
  return { consumo, recepcion, recargas, hasData: raw.length > 0, sigma, last: smooth.length ? smooth[smooth.length - 1] : null };
}

/**
 * siloHistoryAll : { "AAAA-MM-DD": { tanque1: [{time, value(%)}], ... } }
 * silos          : [{ id, product, toTon(percent) }]
 * dateKeys       : días a calcular (ascendente)
 */
function computeKpi(siloHistoryAll, silos, dateKeys) {
  const round = v => Math.round(v * 100) / 100;
  const result = { days: dateKeys, umbralTon: THRESHOLD_TON, silos: {}, products: {} };

  // Día previo al rango: punto de partida para no perder el cambio de medianoche
  const prev = new Date(dateKeys[0] + "T12:00:00");
  prev.setDate(prev.getDate() - 1);
  const prevKey = prev.getFullYear() + "-" + String(prev.getMonth() + 1).padStart(2, "0") + "-" + String(prev.getDate()).padStart(2, "0");

  silos.forEach(s => {
    const out = { product: s.product, consumo: [], recepcion: [], recargas: [], conDatos: [], ruido: [] };
    let ref = analyzeDay((siloHistoryAll[prevKey] || {})[s.id], s.toTon, null).last;
    dateKeys.forEach(dk => {
      const dayArr = (siloHistoryAll[dk] || {})[s.id];
      const r = analyzeDay(dayArr, s.toTon, ref);
      out.consumo.push(round(r.consumo));
      out.recepcion.push(round(r.recepcion));
      out.recargas.push(r.recargas);
      out.conDatos.push(r.hasData);
      out.ruido.push(round(r.sigma));                 // ruido del radar ese día (t, 1σ)
      if (r.last != null) ref = r.last;
    });
    result.silos[s.id] = out;

    if (!result.products[s.product]) {
      result.products[s.product] = {
        consumo: dateKeys.map(() => 0), recepcion: dateKeys.map(() => 0),
        recargas: dateKeys.map(() => 0), conDatos: dateKeys.map(() => false)
      };
    }
    const p = result.products[s.product];
    dateKeys.forEach((dk, i) => {
      p.consumo[i]   = round(p.consumo[i] + out.consumo[i]);
      p.recepcion[i] = round(p.recepcion[i] + out.recepcion[i]);
      p.recargas[i] += out.recargas[i];
      p.conDatos[i]  = p.conDatos[i] || out.conDatos[i];
    });
  });

  return result;
}

module.exports = { computeKpi, THRESHOLD_TON, RECHARGE_MIN_TON };

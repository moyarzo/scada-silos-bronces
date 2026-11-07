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
// Bajas = consumo · subidas = recepción.
//
// Recarga = subida GRADUAL que supera KPI_RECARGA_MIN_TON (2 t por defecto): el nivel sube en al
// menos KPI_RECARGA_MIN_PASOS pasos sucesivos del filtro (3, es decir ≥ 15 min subiendo).
// Se cierra con un consumo o tras 30 min sin subir.
// Toda subida que no cumple (de golpe, o menor a 2 t) no es recarga ni recepción. Si el nivel vuelve a
// bajar (oscilación) o la subida fue menor a 2 t (deriva del radar), la referencia vuelve al nivel
// previo para que esa bajada tampoco se cuente como consumo. Una subida de golpe ≥ 2 t que se
// mantiene (ej. recarga completa durante un corte sin datos) pasa a ser el nuevo nivel de referencia.
//
// Saltos (cortes de energía, reinicio del sensor o del HMI): si entre dos lecturas válidas
// consecutivas el % cambia más de KPI_SALTO_PCT puntos por cada 5 min transcurridos (por defecto
// 10 % de la capacidad del silo cada 5 min, más rápido que cualquier descarga de camión), la serie
// se corta en ese punto: el salto
// no se cuenta como consumo ni recepción y el cálculo sigue desde el nuevo valor. Lo mismo al volver
// de un tramo sin datos. Si después del salto el nivel vuelve cerca del valor previo, el tramo
// intermedio se descarta como lectura falsa y se empalman ambos lados (se cuenta el consumo real
// ocurrido durante el corte). Un % exactamente 0 o ≥ 99.5 % (radar entregando distancia 0 al
// reiniciarse; el producto nunca llega a la antena) se trata como "sin dato".

const THRESHOLD_TON      = Number(process.env.KPI_UMBRAL_TON || 0.3);
const RECHARGE_MIN_TON   = Number(process.env.KPI_RECARGA_MIN_TON || 2);
const RECHARGE_MIN_STEPS = Number(process.env.KPI_RECARGA_MIN_PASOS || 3);
const JUMP_PCT           = Number(process.env.KPI_SALTO_PCT || 10);
const MAX_VALID_PCT      = 99.5;
const RECHARGE_GAP       = 6;   // bloques de 5 min sin subir que cierran una recarga (30 min)

const MEDIAN_WINDOW = 7;

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/**
 * dayArr   : [{ time, value(%) }] del día
 * toTon    : % → toneladas
 * start    : { ton, pct } último valor filtrado del día anterior (o null)
 * collect  : (opcional) arreglo donde se agregan los eventos detectados, para la bitácora (lib/eventos.js):
 *            { tipo: "salto" | "falsa" | "recarga" | "recarga_en_curso", min, ... }  (min = minuto del día)
 *            No cambia el cálculo de los indicadores.
 */
function analyzeDay(dayArr, toTon, start, collect) {
  const sorted = (dayArr || []).slice().sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const valid = [];
  sorted.forEach(p => {
    const pct = Number(p.value);
    // Sin dato: 0 % (sin señal / reinicio) o ≥ 99.5 % (producto "tocando" la antena: físicamente
    // imposible, típico de un radar que al reiniciarse entrega distancia 0)
    if (pct > 0 && pct < MAX_VALID_PCT && isFinite(pct)) {
      const hm = String(p.time).split(":");
      valid.push({ pct, ton: toTon(pct), min: Number(hm[0]) * 60 + Number(hm[1]) });
    }
  });

  // Cambio máximo creíble entre dos lecturas separadas por dt minutos (JUMP_PCT cada 5 min)
  const allowed = dt => JUMP_PCT * Math.max(1, dt / 5);
  const isJump = (a, b) => Math.abs(b.pct - a.pct) > allowed(b.min - a.min);

  // 1) Tramos continuos: se cortan donde hay un salto entre lecturas válidas consecutivas
  const segments = [];
  let saltos = 0;
  valid.forEach((v, i) => {
    if (i === 0 || isJump(valid[i - 1], v)) {
      if (i > 0) saltos++;
      segments.push([]);
    }
    segments[segments.length - 1].push(v);
  });

  // 1b) Tramos falsos: si después de un salto el nivel vuelve cerca del valor previo, el tramo
  //     intermedio era una lectura errónea (ej. corte de energía): se descarta y se empalman los
  //     dos lados, así el consumo real ocurrido durante el corte sí se cuenta.
  for (let i = 1; i < segments.length - 1; ) {
    const before = segments[i - 1][segments[i - 1].length - 1];
    const after  = segments[i + 1][0];
    if (!isJump(before, after)) {
      if (collect) {
        const mid = segments[i];
        collect.push({ tipo: "falsa", min: mid[0].min, fin: after.min,
          antes: before.pct, falso: mid[Math.floor(mid.length / 2)].pct, despues: after.pct });
      }
      segments.splice(i - 1, 3, segments[i - 1].concat(segments[i + 1]));
    } else {
      i++;
    }
  }

  // Saltos que quedaron (no eran lecturas falsas): el nivel cambió de golpe y se mantuvo
  if (collect) {
    for (let i = 1; i < segments.length; i++) {
      const a = segments[i - 1][segments[i - 1].length - 1], b = segments[i][0];
      collect.push({ tipo: "salto", min: b.min, desde: a.min, antes: a.pct, despues: b.pct });
    }
  }

  // 2) Mediana móvil dentro de cada tramo (no mezcla valores de ambos lados de un salto)
  const half = MEDIAN_WINDOW >> 1;
  const smoothSegs = segments.map(seg => {
    const tons = seg.map(v => v.ton);
    return seg.map((v, i) => ({ pct: v.pct, min: v.min, ton: median(tons.slice(Math.max(0, i - half), i + half + 1)), raw: v.ton }));
  });

  // 3) Umbral adaptativo según el ruido del día
  const residuals = [];
  smoothSegs.forEach(seg => seg.forEach(v => residuals.push(Math.abs(v.raw - v.ton))));
  const sigma = residuals.length ? 1.4826 * median(residuals) : 0;
  const threshold = Math.max(THRESHOLD_TON, 3 * sigma);

  let consumo = 0, recepcion = 0, recargas = 0, descartado = 0;
  let event = 0, steps = 0, idle = 0, inEvent = false, eventStartRef = null;
  let eventStartMin = null, eventLastMin = null;          // solo para la bitácora
  let ref = null;

  // Cierra una subida en curso. Devuelve true si la referencia volvió al nivel previo.
  //   byDrop: la subida terminó porque el nivel volvió a bajar (oscilación)
  //   atEnd : cierre al final de los datos (la recarga puede seguir en curso)
  function closeEvent(byDrop, atEnd) {
    let rolledBack = false;
    if (inEvent) {
      if (steps >= RECHARGE_MIN_STEPS && event >= RECHARGE_MIN_TON) {
        recepcion += event;
        recargas++;
        if (collect) {
          collect.push({ tipo: atEnd && idle < RECHARGE_GAP ? "recarga_en_curso" : "recarga",
            min: eventStartMin, fin: eventLastMin, ton: event, tonInicio: eventStartRef, tonFin: eventStartRef + event });
        }
      } else {
        descartado += event;          // subida de golpe o < 2 t: no es recarga ni recepción
        // Se vuelve al nivel previo si fue una oscilación (bajó de nuevo) o una deriva pequeña.
        // Una subida grande que se mantiene (ej. recarga completa durante un corte sin datos) pasa
        // a ser el nuevo nivel de referencia, para no perder el consumo posterior.
        if (byDrop || event < RECHARGE_MIN_TON) {
          ref = eventStartRef;
          rolledBack = true;
        }
      }
    }
    inEvent = false; event = 0; steps = 0; idle = 0; eventStartRef = null;
    eventStartMin = null; eventLastMin = null;
    return rolledBack;
  }

  // Compara una lectura con la referencia y cuenta consumo si bajó más que el umbral
  function checkDrop(ton) {
    const d = ton - ref;
    if (d <= -threshold) { consumo += -d; ref = ton; return true; }
    return false;
  }

  // El día anterior solo sirve de punto de partida si no hay salto con la primera lectura
  if (start && smoothSegs.length &&
      !isJump({ pct: start.pct, min: start.min - 1440 }, smoothSegs[0][0])) ref = start.ton;
  else if (start && smoothSegs.length) saltos++;

  smoothSegs.forEach((seg, si) => {
    if (si > 0) { closeEvent(); ref = null; }       // tras un salto se reinicia la referencia
    seg.forEach(v => {
      if (ref == null) { ref = v.ton; return; }
      const d = v.ton - ref;
      if (d <= -threshold) {
        if (inEvent) {
          // Bajada después de una subida: si la subida no calificaba, se anula y se vuelve a
          // medir la bajada desde el nivel previo (solo cuenta lo que baje bajo ese nivel)
          if (closeEvent(true)) { checkDrop(v.ton); return; }
        }
        consumo += -d; ref = v.ton;
      } else if (d >= threshold) {
        if (!inEvent) { inEvent = true; eventStartRef = ref; eventStartMin = v.min; }
        eventLastMin = v.min;
        ref = v.ton;
        event += d; steps++; idle = 0;
      } else if (inEvent && ++idle >= RECHARGE_GAP) {
        closeEvent();
      }
    });
  });
  closeEvent(false, true);

  const lastSeg = smoothSegs[smoothSegs.length - 1];
  const last = lastSeg ? lastSeg[lastSeg.length - 1] : null;
  return {
    consumo, recepcion, recargas, saltos, descartado,
    hasData: valid.length > 0, sigma,
    // El día siguiente parte desde la referencia contable (no desde una subida descartada)
    last: last ? { ton: ref != null ? ref : last.ton, pct: last.pct, min: last.min } : null
  };
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
    const out = { product: s.product, consumo: [], recepcion: [], recargas: [], saltos: [], conDatos: [], ruido: [] };
    let ref = analyzeDay((siloHistoryAll[prevKey] || {})[s.id], s.toTon, null).last;
    dateKeys.forEach(dk => {
      const dayArr = (siloHistoryAll[dk] || {})[s.id];
      const r = analyzeDay(dayArr, s.toTon, ref);
      out.consumo.push(round(r.consumo));
      out.recepcion.push(round(r.recepcion));
      out.recargas.push(r.recargas);
      out.saltos.push(r.saltos);
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

module.exports = { computeKpi, analyzeDay, THRESHOLD_TON, RECHARGE_MIN_TON, JUMP_PCT };

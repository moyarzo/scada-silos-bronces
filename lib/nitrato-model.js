// ===== MODELO DE CÁLCULO SILO NITRATO =====
// Geometría (planilla "Cálculo de MMPP en Silos"), calibración del radar y nivel/volumen.
// Lo usan el servidor (lib/nitrato.js) y la herramienta de recálculo de historial
// (tools/recalcular-historial-nitrato.js), así ambos calculan exactamente igual.

function createNitratoModel() {
  // ===== GEOMETRÍA SILO NITRATO (igual a la planilla "Cálculo de MMPP en Silos") =====
  // Distancias medidas desde el borde superior de la zona recta (medición manual − 0.09 m de escotilla).
  //   Columna          : 3.48 × 3.48 m, alto 5.95 m
  //   Embudo intermedio: pirámide truncada 3.48 → 2.78 m (lado), alto 0.78 m
  //   Embudos finales  : 2 pirámides truncadas, sup 1.39 × 2.78 m → inf 0.32 × 0.38 m, alto 1.16 m
  // Alto total 7.89 m · volumen total 83.34 m³ · el nivel se mide desde el fondo de los embudos finales.
  const N_CYL_HEIGHT   = 5.95;
  const N_CYL_SIDE     = 3.48;
  const N_INT_HEIGHT   = 0.78;
  const N_INT_SIDE_INF = 2.78;
  const N_FIN_HEIGHT   = 1.16;
  const N_FIN_SUP      = [1.39, 2.78];
  const N_FIN_INF      = [0.32, 0.38];
  const N_FIN_COUNT    = 2;
  const N_TOLVA_HEIGHT = N_INT_HEIGHT + N_FIN_HEIGHT;            // 1.94 m (embudos)
  const N_MAX_HEIGHT   = N_TOLVA_HEIGHT + N_CYL_HEIGHT;          // 7.89 m
  const ESCOTILLA      = 0.09;                                   // alto escotilla (medición manual)

  // ===== CALIBRACIÓN RADAR → DISTANCIA REAL =====
  // Puntos de terreno: lectura del radar vs distancia real desde el borde superior de la zona recta.
  // Con estos puntos se ajusta al arrancar una recta  distancia = A·radar + B  (mínimos cuadrados).
  // Para recalibrar: agregar filas nuevas y reiniciar (pm2 restart scada-silos).
  // Todas las mediciones (LiDAR y manual vertical) se tomaron desde el nivel de la escotilla:
  // real = medición − ESCOTILLA (igual que la planilla). Con esto LiDAR, manual y radar coinciden (±1 cm promedio).
  const RADAR_CALIBRATION = [
    { radar: 0.34, real: 0.30 - ESCOTILLA },        // 06-06 LiDAR, silo lleno
    { radar: 0.91, real: 1.05 - ESCOTILLA },        // 17-06 LiDAR, llenando
    { radar: 1.16, real: 1.22 - ESCOTILLA },        // 08-06 LiDAR, vaciando
    { radar: 2.23, real: 2.35 - ESCOTILLA },        // 08-06 LiDAR, vaciando
    { radar: 2.33, real: 2.42 - ESCOTILLA },        // 21-06 LiDAR, vaciando
    { radar: 2.52, real: 2.68 - ESCOTILLA },        // 05-06 / 09-06 LiDAR
    { radar: 2.60, real: 2.70 - ESCOTILLA },        // 04-11 manual 2.70 m (planilla 38.8 t)
    { radar: 3.00, real: 3.10 - ESCOTILLA }         // 05-11 manual 3.10 m (planilla 35.2 t)
    // Excluido: 22-06 radar 4.05 / LiDAR 5.59 → superficie con cráter (M1 6.45 vs M3 4.90).
  ];

  const RADAR_FIT = (function fitLine(points) {
    const n = points.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    points.forEach(p => { sx += p.radar; sy += p.real; sxx += p.radar * p.radar; sxy += p.radar * p.real; });
    const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return { a: a, b: (sy - a * sx) / n };
  })(RADAR_CALIBRATION);

  // ===== SILO VACÍO (ajuste empírico de los embudos finales) =====
  // Con el silo vacío el radar lee ~7.05 m: no alcanza a ver el fondo de los dos embudos finales.
  // Entre el inicio de los embudos finales y esa lectura, el nivel se interpola hasta el nivel
  // que contiene la masa residual real (por defecto 0.10 t). Se muestra con "≈".
  // Ajuste fino sin tocar código: NITRATO_MASA_VACIO_TON en el .env
  const RADAR_EMPTY_DIST = 7.05;
  const MASA_VACIO_TON   = Number(process.env.NITRATO_MASA_VACIO_TON || 0.10);

  // Densidad del nitrato (kg/m³), la misma de la planilla. Ajuste: NITRATO_DENSIDAD en el .env
  const PRODUCTS = {
    "Nitrato": { density: Number(process.env.NITRATO_DENSIDAD || 750) }
  };

  // ===== CÁLCULO DE VOLUMEN (fórmulas de la planilla, en función del nivel desde el fondo) =====

  function frustum(h, areaSup, areaInf) {
    return (h / 3) * (areaSup + areaInf + Math.sqrt(areaSup * areaInf));
  }

  function calculateVolume(level) {
    const s = Math.max(0, Math.min(N_MAX_HEIGHT, level));

    // Embudos finales (2 pirámides truncadas)
    const hFin = Math.min(s, N_FIN_HEIGHT);
    const f1   = N_FIN_INF[0] + (N_FIN_SUP[0] - N_FIN_INF[0]) * hFin / N_FIN_HEIGHT;
    const f2   = N_FIN_INF[1] + (N_FIN_SUP[1] - N_FIN_INF[1]) * hFin / N_FIN_HEIGHT;
    let v = N_FIN_COUNT * frustum(hFin, f1 * f2, N_FIN_INF[0] * N_FIN_INF[1]);

    // Embudo intermedio
    if (s > N_FIN_HEIGHT) {
      const hInt = Math.min(s - N_FIN_HEIGHT, N_INT_HEIGHT);
      const side = N_INT_SIDE_INF + (N_CYL_SIDE - N_INT_SIDE_INF) * hInt / N_INT_HEIGHT;
      v += frustum(hInt, side * side, N_INT_SIDE_INF * N_INT_SIDE_INF);
    }

    // Columna
    if (s > N_TOLVA_HEIGHT) {
      v += N_CYL_SIDE * N_CYL_SIDE * (s - N_TOLVA_HEIGHT);
    }
    return v;
  }

  const N_V_TOTAL = calculateVolume(N_MAX_HEIGHT);   // 83.34 m³

  // Nivel (desde el fondo) que contiene la masa residual de silo vacío
  const EMPTY_LEVEL = (function () {
    const target = (MASA_VACIO_TON * 1000) / PRODUCTS["Nitrato"].density;
    let lo = 0, hi = N_FIN_HEIGHT;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (calculateVolume(mid) < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  })();

  // ===== NIVEL DESDE RADAR =====
  // distancia real = A·radar + B (recta calibrada)
  //   distancia ≤ 5.95 m          : columna → nivel = 7.89 − distancia
  //   5.95 – 6.73 m               : embudo intermedio → nivel = 7.89 − distancia (≈)
  //   6.73 m – lectura de vacío   : embudos finales, aproximado hasta el nivel de silo vacío (≈)
  //   ≥ lectura de vacío (7.05 m) : silo vacío
  // Devuelve { level, approx }.

  function lerp(x, x0, y0, x1, y1) {
    return x1 === x0 ? y0 : y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }

  const DIST_FIN_START = N_CYL_HEIGHT + N_INT_HEIGHT;                     // 6.73 m
  const DIST_EMPTY     = RADAR_FIT.a * RADAR_EMPTY_DIST + RADAR_FIT.b;    // distancia real de "vacío"

  function levelFromRadar(radar) {
    const dist = RADAR_FIT.a * radar + RADAR_FIT.b;
    let level, approx;

    if (dist <= DIST_FIN_START) {
      level  = N_MAX_HEIGHT - dist;
      approx = dist > N_CYL_HEIGHT;
    } else if (dist < DIST_EMPTY) {
      level  = lerp(dist, DIST_FIN_START, N_FIN_HEIGHT, DIST_EMPTY, EMPTY_LEVEL);
      approx = true;
    } else {
      level  = EMPTY_LEVEL;
      approx = true;
    }
    return { level: Math.max(0, Math.min(N_MAX_HEIGHT, level)), approx };
  }

  return {
    N_CYL_HEIGHT, N_TOLVA_HEIGHT, N_MAX_HEIGHT, N_V_TOTAL, ESCOTILLA,
    RADAR_CALIBRATION, RADAR_FIT, RADAR_EMPTY_DIST, MASA_VACIO_TON, EMPTY_LEVEL,
    PRODUCTS, calculateVolume, levelFromRadar, lerp
  };
}

module.exports = { createNitratoModel };

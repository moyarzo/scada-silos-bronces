// ===== SISTEMA SILOS NITRATO DE AMONIO =====
// Backend original de scada-nitrato (con calibración empírica radar), encapsulado como módulo.
// Socket.IO namespace: /nitrato   ·   Rutas HTTP: /nitrato/*
// Archivos de datos con prefijo "nitrato_" para no mezclarse con los de Matriz.

const fs = require("fs");
const path = require("path");
const mqtt = require("mqtt");
const ExcelJS = require("exceljs");

const {
  readJson, writeJson, today, formatDateYYYYMMDD, getDateKeyDaysAgo,
  getRounded5MinLabel, getServerTime, getLast30DateKeys, getValueNearTime,
  uint32ToFloatWordSwap, extractDeltaRawValue
} = require("./utils");

module.exports = function setupNitrato(options) {
  const app = options.app;
  const io = options.io;                 // namespace /nitrato
  const requireAuth = options.requireAuth;
  const requireAdmin = options.requireAdmin;   // descargas solo para Admin
  const BASE_DIR = options.baseDir;

  // ===== CONSTANTES SILO NITRATO =====
  const N_TOLVA_HEIGHT = 0.78;
  const N_CYL_HEIGHT   = 5.95;
  const N_MAX_HEIGHT   = N_TOLVA_HEIGHT + N_CYL_HEIGHT;  // 6.73 m
  const N_A_INF        = 2.78;
  const N_A_SUP        = 3.48;
  const N_DA           = N_A_SUP - N_A_INF;
  const N_B            = N_DA / N_TOLVA_HEIGHT;
  const N_V_TOLVA      = 7.6734;
  const N_V_TOTAL      = N_V_TOLVA + N_A_SUP * N_A_SUP * N_CYL_HEIGHT;  // 79.73 m³

  // ===== CALIBRACIÓN RADAR → DISTANCIA REAL (zona recta) =====
  // Puntos de terreno: lectura del radar vs distancia real medida verticalmente
  // (m desde el borde superior de la zona recta). Nivel real = N_MAX_HEIGHT − distancia.
  // Con estos puntos se ajusta al arrancar una recta  distancia = A·radar + B  (mínimos cuadrados).
  // Para recalibrar: agregar filas nuevas y reiniciar (pm2 restart scada-silos).
  const RADAR_CALIBRATION = [
    { radar: 0.34, real: 0.30 },   // 06-06 LiDAR, silo lleno
    { radar: 0.91, real: 1.05 },   // 17-06 LiDAR, llenando
    { radar: 1.16, real: 1.22 },   // 08-06 LiDAR, vaciando
    { radar: 2.23, real: 2.35 },   // 08-06 LiDAR, vaciando
    { radar: 2.33, real: 2.42 },   // 21-06 LiDAR, vaciando
    { radar: 2.52, real: 2.68 },   // 05-06 / 09-06 LiDAR
    { radar: 2.60, real: 2.70 },   // 04-11 manual vertical, recarga (38 t)
    { radar: 3.00, real: 3.10 }    // 05-11 manual vertical, tras extraer 4 t (34 t)
    // Excluido: 22-06 radar 4.05 / LiDAR 5.59 → superficie con cráter (M1 6.45 vs M3 4.90),
    // punto atípico que deformaba toda la curva entre 2.5 y 4 m.
  ];

  const RADAR_FIT = (function fitLine(points) {
    const n = points.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    points.forEach(p => { sx += p.radar; sy += p.real; sxx += p.radar * p.radar; sxy += p.radar * p.real; });
    const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return { a: a, b: (sy - a * sx) / n };
  })(RADAR_CALIBRATION);

  // Silo vacío (23-06): radar 7.05 m con 0.70 m³ residuales en tolva
  const RADAR_EMPTY_DIST  = 7.05;
  const RADAR_EMPTY_LEVEL = 0.088;   // altura en tolva que contiene 0.70 m³

  // ===== AJUSTE EMPÍRICO DE LA TOLVA =====
  // Con el silo vacío (verificado en terreno, nov-2026) el radar indica ~0.09 m,
  // pero la geometría de pirámide truncada (base 2.78 x 2.78 m) da 0.70 m³ / 0.52 t
  // para esa altura, cuando el residuo real es ~0.10 t.
  // Corrección: dentro de la tolva (nivel < 0.78 m) el volumen geométrico se multiplica
  // por un factor que va de 1 (borde superior de la tolva) al factor de silo vacío
  // (en RADAR_EMPTY_LEVEL), variando linealmente con la altura.
  // Ajuste fino: cambiar NITRATO_MASA_VACIO_TON en el .env (sin tocar código).
  const MASA_VACIO_TON = Number(process.env.NITRATO_MASA_VACIO_TON || 0.10);   // t residuales con silo vacío

  // Densidad aparente efectiva del nitrato (kg/m³). Calibrada con la recarga del 04-11 (38 t)
  // y la extracción del 05-11 (34 t): ambas dan ≈ 805 kg/m³ con la geometría del silo.
  // Ajuste fino sin tocar código: NITRATO_DENSIDAD en el .env
  const PRODUCTS = {
    "Nitrato": { density: Number(process.env.NITRATO_DENSIDAD || 805) }
  };

  const latestSilos = {
    tanque1: { levelMeters: 0, volume: 0, percent: 0, approx: false },
    tanque2: { levelMeters: 0, volume: 0, percent: 0, approx: false },
    tanque3: { levelMeters: 0, volume: 0, percent: 0, approx: false },
    tanque4: { levelMeters: 0, volume: 0, percent: 0, approx: false },
    tanque5: { levelMeters: 0, volume: 0, percent: 0, approx: false },
    tanque6: { levelMeters: 0, volume: 0, percent: 0, approx: false },
    tanque7: { levelMeters: 0, volume: 0, percent: 0, approx: false },
    tanque8: { levelMeters: 0, volume: 0, percent: 0, approx: false }
  };

  // ===== ARCHIVOS =====
  const TURN_FILE          = path.join(BASE_DIR, "nitrato_turnData.json");
  const HISTORY_FILE       = path.join(BASE_DIR, "nitrato_historyData.json");
  const SILO_HISTORY_FILE  = path.join(BASE_DIR, "nitrato_siloHistoryData.json");
  const DAILY_SUMMARY_FILE = path.join(BASE_DIR, "nitrato_dailySummary.json");
  const TEMPLATE_FILE      = path.join(BASE_DIR, "template.xlsx");
  const EXPORTS_DIR        = path.join(BASE_DIR, "exports");

  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

  // ===== CÁLCULO DE VOLUMEN =====

  function calculateVolume(level) {
    const s = Math.max(0, Math.min(N_MAX_HEIGHT, level));
    if (s <= N_TOLVA_HEIGHT) {
      const A = N_A_INF, B = N_B;
      return (Math.pow(A + B * s, 3) - Math.pow(A, 3)) / (3 * B);
    }
    return N_V_TOLVA + N_A_SUP * N_A_SUP * (s - N_TOLVA_HEIGHT);
  }

  // Volumen con ajuste empírico en la zona de tolva (ver AJUSTE EMPÍRICO DE LA TOLVA)
  function tolvaFactor(level) {
    if (level >= N_TOLVA_HEIGHT) return 1;
    const vEmptyGeom = calculateVolume(RADAR_EMPTY_LEVEL);                      // 0.70 m³ geométricos
    const vEmptyReal = (MASA_VACIO_TON * 1000) / PRODUCTS["Nitrato"].density;   // 0.10 t → 0.133 m³
    const fEmpty     = Math.max(0, Math.min(1, vEmptyReal / vEmptyGeom));
    if (level <= RADAR_EMPTY_LEVEL) return fEmpty;
    return lerp(level, RADAR_EMPTY_LEVEL, fEmpty, N_TOLVA_HEIGHT, 1);
  }

  function calculateVolumeCorrected(level) {
    const s = Math.max(0, Math.min(N_MAX_HEIGHT, level));
    return calculateVolume(s) * tolvaFactor(s);
  }

  // ===== NIVEL DESDE RADAR =====
  // Zona recta : distancia real = A·radar + B (recta calibrada) → nivel = 6.73 − distancia.
  // Zona tolva : bajo 0.78 m de nivel, cálculo aproximado (interpolación hasta el punto de silo vacío).
  // Devuelve { level, approx }.

  function lerp(x, x0, y0, x1, y1) {
    return x1 === x0 ? y0 : y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }

  // Lectura del radar que corresponde al borde superior de la tolva (nivel 0.78 m)
  const RADAR_TOLVA_DIST = (N_CYL_HEIGHT - RADAR_FIT.b) / RADAR_FIT.a;

  function levelFromRadar(dist) {
    let level, approx = false;

    if (dist <= RADAR_TOLVA_DIST) {
      level = N_MAX_HEIGHT - (RADAR_FIT.a * dist + RADAR_FIT.b);
    } else if (dist < RADAR_EMPTY_DIST) {
      level  = lerp(dist, RADAR_TOLVA_DIST, N_TOLVA_HEIGHT, RADAR_EMPTY_DIST, RADAR_EMPTY_LEVEL);
      approx = true;
    } else {
      level  = RADAR_EMPTY_LEVEL;
      approx = true;
    }
    return { level: Math.max(0, Math.min(N_MAX_HEIGHT, level)), approx };
  }


  console.log("[Nitrato] Calibración radar: distancia = " + RADAR_FIT.a.toFixed(4) + "·radar + " +
    RADAR_FIT.b.toFixed(4) + " | tolva desde radar " + RADAR_TOLVA_DIST.toFixed(2) + " m | densidad " +
    PRODUCTS["Nitrato"].density + " kg/m³ | masa vacío " + MASA_VACIO_TON + " t");

  // ===== TOTALES =====

  function getCurrentTotals() {
    let total = 0;
    Object.keys(latestSilos).forEach(tanque => {
      total += (latestSilos[tanque].volume || 0) * PRODUCTS["Nitrato"].density / 1000;
    });
    return { "Nitrato": total };
  }

  // ===== HISTORIAL =====

  function defaultHistoryDay() { return { "Nitrato": [] }; }

  function getProductHistoryByDate(dateKey) {
    const all = readJson(HISTORY_FILE, {});
    return all[dateKey] || defaultHistoryDay();
  }

  function getTodayHistory() { return getProductHistoryByDate(today()); }

  function getDefaultSiloHistoryDay() {
    return { tanque1:[],tanque2:[],tanque3:[],tanque4:[],tanque5:[],tanque6:[],tanque7:[],tanque8:[] };
  }

  function getSiloHistoryByDate(dateKey) {
    const all = readJson(SILO_HISTORY_FILE, {});
    return all[dateKey] || getDefaultSiloHistoryDay();
  }

  function getTodaySiloHistory() { return getSiloHistoryByDate(today()); }

  // ===== GUARDADO HISTÓRICO CADA 5 MIN =====

  function updatePersistentHistory() {
    const allHistory  = readJson(HISTORY_FILE, {});
    const siloHistory = readJson(SILO_HISTORY_FILE, {});
    const day         = today();
    const label       = getRounded5MinLabel();
    const totals      = getCurrentTotals();

    if (!allHistory[day])  allHistory[day]  = defaultHistoryDay();
    if (!siloHistory[day]) siloHistory[day] = getDefaultSiloHistoryDay();

    // Historial de totalizador
    const arr  = allHistory[day]["Nitrato"] || [];
    const last = arr[arr.length - 1];
    if (!last)                    arr.push({ time: label, value: totals["Nitrato"] });
    else if (last.time !== label) arr.push({ time: label, value: totals["Nitrato"] });
    else                          last.value = totals["Nitrato"];
    allHistory[day]["Nitrato"] = arr;

    // Historial por silo (% llenado)
    Object.keys(latestSilos).forEach(tanque => {
      const sarr  = siloHistory[day][tanque] || [];
      const slast = sarr[sarr.length - 1];
      const pct   = latestSilos[tanque].percent || 0;
      if (!slast)                      sarr.push({ time: label, value: pct });
      else if (slast.time !== label)   sarr.push({ time: label, value: pct });
      else                             slast.value = pct;
      siloHistory[day][tanque] = sarr;
    });

    writeJson(HISTORY_FILE,      allHistory);
    writeJson(SILO_HISTORY_FILE, siloHistory);

    io.emit("historyData",   { date: day, history: getTodayHistory() });
    io.emit("siloTrendData", { date: day, history: getTodaySiloHistory() });
  }

  // ===== VARIACIONES =====

  function calculateVariationsFromHistory(dayHistory) {
    const arr = (dayHistory["Nitrato"] || []).slice()
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));
    let positive = 0, negative = 0;
    for (let i = 1; i < arr.length; i++) {
      const prev = Number(arr[i-1].value), curr = Number(arr[i].value);
      if (isNaN(prev) || isNaN(curr)) continue;
      const diff = curr - prev;
      if (diff > 0) positive += diff;
      else if (diff < 0) negative += Math.abs(diff);
    }
    return { "Nitrato": { positive, negative } };
  }

  function calculateDailyVariations() {
    return calculateVariationsFromHistory(getTodayHistory());
  }

  // ===== TURNOS =====

  function checkShift() {
    const h      = new Date().getHours();
    const d      = readJson(TURN_FILE, {});
    const t      = today();
    const totals = getCurrentTotals();
    if (!d[t]) d[t] = {};
    if (h >= 7  && !d[t].start) d[t].start = totals;
    if (h >= 19 && !d[t].end)   d[t].end   = totals;
    writeJson(TURN_FILE, d);
    io.emit("turnData", { date: t, data: d[t] || {} });
  }

  function getTodayTurnData() {
    const d = readJson(TURN_FILE, {});
    return d[today()] || {};
  }

  // ===== RESUMEN DIARIO =====

  function buildDaySummary(dateKey, dayHistory, turnDay, variations) {
    const arr    = dayHistory["Nitrato"] || [];
    const inicio = (turnDay && turnDay.start && turnDay.start["Nitrato"] != null)
      ? Number(turnDay.start["Nitrato"])
      : getValueNearTime(arr, "07:00");
    const fin    = (turnDay && turnDay.end && turnDay.end["Nitrato"] != null)
      ? Number(turnDay.end["Nitrato"])
      : getValueNearTime(arr, "19:00");

    return {
      date: dateKey,
      "Nitrato": {
        inicio: inicio != null ? Number(inicio.toFixed(2)) : null,
        fin:    fin    != null ? Number(fin.toFixed(2))    : null,
        varPos: Number((variations["Nitrato"].positive).toFixed(2)),
        varNeg: Number((variations["Nitrato"].negative).toFixed(2))
      }
    };
  }

  function saveDailySummary() {
    const dayKey     = today();
    const dayHistory = getTodayHistory();
    const turnAll    = readJson(TURN_FILE, {});
    const variations = calculateVariationsFromHistory(dayHistory);
    const summary    = buildDaySummary(dayKey, dayHistory, turnAll[dayKey] || {}, variations);
    const all        = readJson(DAILY_SUMMARY_FILE, {});
    all[dayKey]      = summary;
    writeJson(DAILY_SUMMARY_FILE, all);
    console.log("[Nitrato] Resumen diario guardado para:", dayKey);
    return summary;
  }

  function getLast30DailySummaries() {
    const all     = readJson(DAILY_SUMMARY_FILE, {});
    const allHist = readJson(HISTORY_FILE, {});
    const turnAll = readJson(TURN_FILE, {});
    const result  = [];
    for (let i = 29; i >= 0; i--) {
      const dk = getDateKeyDaysAgo(i);
      if (all[dk]) { result.push(all[dk]); continue; }
      const dh = allHist[dk];
      if (dh) {
        const variations = calculateVariationsFromHistory(dh);
        result.push(buildDaySummary(dk, dh, turnAll[dk] || {}, variations));
      }
    }
    return result;
  }

  // ===== CSV RESUMEN DIARIO =====

  function buildDailySummaryCsv() {
    const summaries = getLast30DailySummaries();
    const header = [
      "Fecha",
      "Nitrato Inicio 07h (ton)",
      "Nitrato Fin 19h (ton)",
      "Nitrato Var.Positiva (ton)",
      "Nitrato Var.Negativa (ton)"
    ].join(",");

    const rows = summaries.map(s => {
      const n = s["Nitrato"] || {};
      return [
        s.date,
        n.inicio != null ? n.inicio : "",
        n.fin    != null ? n.fin    : "",
        n.varPos != null ? n.varPos : "",
        n.varNeg != null ? n.varNeg : ""
      ].join(",");
    });

    return header + "\n" + rows.join("\n");
  }

  // ===== EXCEL DIARIO =====

  async function buildExportExcel() {
    if (!fs.existsSync(TEMPLATE_FILE)) throw new Error("No se encontró template.xlsx");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(TEMPLATE_FILE);
    const sheet = workbook.getWorksheet("Hoja1");
    if (!sheet) throw new Error('No se encontró la hoja "Hoja1"');

    const totals     = getCurrentTotals();
    const turn       = getTodayTurnData();
    const variations = calculateDailyVariations();

    // Totalizador
    sheet.getCell("C4").value = Number(totals["Nitrato"].toFixed(1));

    // Registro turno
    sheet.getCell("C9").value  = turn.start?.["Nitrato"] != null ? Number(turn.start["Nitrato"].toFixed(1)) : "";
    sheet.getCell("C10").value = turn.end?.["Nitrato"]   != null ? Number(turn.end["Nitrato"].toFixed(1))   : "";

    // Variaciones
    sheet.getCell("C11").value = Number(variations["Nitrato"].positive.toFixed(1));
    sheet.getCell("C12").value = Number(variations["Nitrato"].negative.toFixed(1));

    // Toneladas por silo
    for (let i = 1; i <= 8; i++) {
      const row    = 16 + i;
      const tanque = "tanque" + i;
      const vol    = latestSilos[tanque]?.volume || 0;
      const ton    = (vol * PRODUCTS["Nitrato"].density) / 1000;
      sheet.getCell("C" + row).value = "Nitrato";
      sheet.getCell("D" + row).value = Number(ton.toFixed(2));
    }

    const fileName = "stock_nitrato_" + formatDateYYYYMMDD() + ".xlsx";
    const filePath = path.join(EXPORTS_DIR, fileName);
    await workbook.xlsx.writeFile(filePath);
    return { fileName, filePath };
  }

  // ===== MQTT =====

  // Topics de los silos de Nitrato (mismo HMI que Matriz):
  //   planta/losbronces/silos/tanque11 → Silo 1 Nitrato … tanque18 → Silo 8 Nitrato
  // (tanque1 … tanque8 del mismo prefijo son los silos de Matriz y se ignoran aquí).
  // Se identifica el silo por el último segmento del topic. "silo11" … "silo18" se aceptan como alias.
  // MQTT_TOPIC_NITRATO permite fijar las suscripciones (separadas por coma).
  const NITRATO_TOPIC_TO_TANQUE = {};
  for (let i = 1; i <= 8; i++) {
    NITRATO_TOPIC_TO_TANQUE["tanque1" + i] = "tanque" + i;   // tanque11 → tanque1 …
    NITRATO_TOPIC_TO_TANQUE["silo1" + i]   = "tanque" + i;   // alias
  }

  const MQTT_URL    = process.env.MQTT_URL_NITRATO || process.env.MQTT_URL || "mqtt://localhost:1883";
  const MQTT_TOPICS = process.env.MQTT_TOPIC_NITRATO
    ? process.env.MQTT_TOPIC_NITRATO.split(",").map(t => t.trim()).filter(Boolean)
    : ["planta/losbronces/silos/#"];

  const client = mqtt.connect(MQTT_URL);

  client.on("connect", () => {
    console.log("[Nitrato] MQTT conectado:", MQTT_URL, MQTT_TOPICS.join(", "));
    client.subscribe(MQTT_TOPICS);
  });

  client.on("error", e => console.error("[Nitrato] Error MQTT:", e.message));

  client.on("message", (topic, message) => {
    try {
      const parts  = topic.split("/");
      const tanque = NITRATO_TOPIC_TO_TANQUE[parts[parts.length - 1]];   // tanque11 → tanque1 …

      if (!tanque || !latestSilos[tanque]) return;

      const payload  = JSON.parse(message.toString());
      const rawValue = extractDeltaRawValue(payload);
      if (rawValue == null) return;

      const rawUint32 = parseInt(rawValue, 10);
      if (isNaN(rawUint32)) return;

      let sensorDistance = uint32ToFloatWordSwap(rawUint32);
      if (isNaN(sensorDistance) || !isFinite(sensorDistance)) return;

      if (sensorDistance < 0 || sensorDistance > 10) return;   // lectura fuera de rango físico

      // Nivel según tabla empírica radar (reemplaza 6.73 − distancia × 0.98)
      const { level, approx } = levelFromRadar(sensorDistance);
      const volume  = calculateVolumeCorrected(level);            // geometría + ajuste empírico en tolva
      const percent = (volume / N_V_TOTAL) * 100;              // % volumétrico, igual que la tabla

      latestSilos[tanque] = { levelMeters: level, volume, percent, approx, density: PRODUCTS["Nitrato"].density };

      io.emit("nivel",     { tanque, topic, nivel: String(sensorDistance), serverTime: getServerTime() });
      io.emit("siloState", latestSilos);

      console.log(`[Nitrato] MQTT ${tanque} radar=${sensorDistance.toFixed(3)}m level=${level.toFixed(3)}m vol=${volume.toFixed(2)}m3 ${percent.toFixed(1)}%${approx ? ' (aprox)' : ''}`);
    } catch(e) { console.error("[Nitrato] Error MQTT:", e, message.toString()); }
  });

  // ===== TAREAS PERIÓDICAS =====

  let dailySummarySavedToday = false;

  function checkDailySummaryTrigger() {
    const h = new Date().getHours(), m = new Date().getMinutes();
    if (h === 19 && m < 5) {
      if (!dailySummarySavedToday) { saveDailySummary(); dailySummarySavedToday = true; }
    } else {
      dailySummarySavedToday = false;
    }
  }

  setInterval(checkShift,                60000);
  setInterval(updatePersistentHistory,   60000);
  setInterval(checkDailySummaryTrigger,  60000);

  // ===== RUTAS HTTP (solo usuario Admin) =====

  app.get("/nitrato/export-data", requireAdmin, async (req, res) => {
    try {
      const f = await buildExportExcel();
      res.download(f.filePath, f.fileName);
    } catch(e) { console.error(e); res.status(500).send("Error generando Excel"); }
  });

  app.get("/nitrato/export-daily-summary", requireAdmin, (req, res) => {
    try {
      const csv      = buildDailySummaryCsv();
      const fileName = "resumen_nitrato_" + formatDateYYYYMMDD() + ".csv";
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=" + fileName);
      res.send(csv);
    } catch(e) { console.error(e); res.status(500).send("Error generando CSV"); }
  });

  app.get("/nitrato/export-trend", requireAdmin, (req, res) => res.redirect("/nitrato/export-daily-summary"));

  // ===== SOCKET (namespace /nitrato) =====

  io.on("connection", socket => {
    const username = socket.handshake.session && socket.handshake.session.user;
    if (!username) { socket.disconnect(true); return; }

    socket.on("getTurnData", payload => {
      const dateKey = (payload && payload.date) || today();
      const d       = readJson(TURN_FILE, {});
      socket.emit("turnData", { date: dateKey, data: d[dateKey] || {} });
    });

    socket.on("getSiloConfig", () => {
      // Producto fijo, no hay config que cambiar
      socket.emit("siloConfig", {
        tanque1:"Nitrato", tanque2:"Nitrato", tanque3:"Nitrato", tanque4:"Nitrato",
        tanque5:"Nitrato", tanque6:"Nitrato", tanque7:"Nitrato", tanque8:"Nitrato"
      });
    });

    socket.on("getHistoryDates", () => {
      socket.emit("historyDates", getLast30DateKeys());
    });

    socket.on("getHistoryData", payload => {
      const dateKey = (payload && payload.date) || today();
      socket.emit("historyData", { date: dateKey, history: getProductHistoryByDate(dateKey) });
    });

    socket.on("getSiloTrendData", payload => {
      const dateKey = (payload && payload.date) || today();
      socket.emit("siloTrendData", { date: dateKey, history: getSiloHistoryByDate(dateKey) });
    });

    socket.on("getSiloState", () => {
      socket.emit("siloState", latestSilos);
    });
  });

  return {
    latestSilos,
    calculateVolume,
    calculateVolumeCorrected,
    levelFromRadar,
    getCurrentTotals,
    saveDailySummary
  };
};

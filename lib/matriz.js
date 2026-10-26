// ===== SISTEMA SILOS MATRIZ (DL-5 / VE-03 / ASE) =====
// Backend original de scada-matriz, encapsulado como módulo.
// Socket.IO namespace: /matriz   ·   Rutas HTTP: /matriz/*
// Archivos de datos: mismos nombres que el proyecto original (no se pierde historial).

const fs = require("fs");
const path = require("path");
const mqtt = require("mqtt");
const ExcelJS = require("exceljs");

const {
  readJson, writeJson, today, formatDateYYYYMMDD, getDateKeyDaysAgo,
  getRounded5MinLabel, getServerTime, getLast30DateKeys, getValueNearTime,
  uint32ToFloatWordSwap, extractDeltaRawValue
} = require("./utils");

module.exports = function setupMatriz(options) {
  const app = options.app;
  const io = options.io;                 // namespace /matriz
  const requireAuth = options.requireAuth;
  const requireAdmin = options.requireAdmin;   // descargas solo para Admin
  const BASE_DIR = options.baseDir;

  // ===== CONFIG =====

  const CONE_HEIGHT = 1.67;
  const CYL_HEIGHT = 4.25;
  const MAX_HEIGHT = CONE_HEIGHT + CYL_HEIGHT;
  const V_TOTAL = 46.168;

  const ratio = (1 / 3) * (CONE_HEIGHT / CYL_HEIGHT);
  const V_CYL = V_TOTAL / (1 + ratio);
  const V_CONE = V_TOTAL - V_CYL;

  const PRODUCTS = {
    "DL-5": { density: 1300 },
    "VE-03": { density: 1370 },
    "ASE": { density: 800 }
  };

  const DEFAULT_SILO_PRODUCTS = {
    tanque1: "DL-5",
    tanque2: "DL-5",
    tanque3: "DL-5",
    tanque4: "DL-5",
    tanque5: "DL-5",
    tanque6: "ASE",
    tanque7: "DL-5",
    tanque8: "DL-5"
  };

  const latestSilos = {
    tanque1: { levelMeters: 0, volume: 0, percent: 0 },
    tanque2: { levelMeters: 0, volume: 0, percent: 0 },
    tanque3: { levelMeters: 0, volume: 0, percent: 0 },
    tanque4: { levelMeters: 0, volume: 0, percent: 0 },
    tanque5: { levelMeters: 0, volume: 0, percent: 0 },
    tanque6: { levelMeters: 0, volume: 0, percent: 0 },
    tanque7: { levelMeters: 0, volume: 0, percent: 0 },
    tanque8: { levelMeters: 0, volume: 0, percent: 0 }
  };

  const TURN_FILE          = path.join(BASE_DIR, "turnData.json");
  const CONFIG_FILE        = path.join(BASE_DIR, "siloConfig.json");
  const HISTORY_FILE       = path.join(BASE_DIR, "historyData.json");
  const SILO_HISTORY_FILE  = path.join(BASE_DIR, "siloHistoryData.json");
  const DAILY_SUMMARY_FILE = path.join(BASE_DIR, "dailySummary.json");
  const TEMPLATE_FILE      = path.join(BASE_DIR, "template.xlsx");
  const EXPORTS_DIR        = path.join(BASE_DIR, "exports");

  if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  }

  // ===== CONFIG PRODUCTOS =====

  function getSiloProducts() {
    var cfg = readJson(CONFIG_FILE, DEFAULT_SILO_PRODUCTS);
    var merged = Object.assign({}, DEFAULT_SILO_PRODUCTS);

    Object.keys(cfg || {}).forEach(function (tanque) {
      if (merged[tanque] && PRODUCTS[cfg[tanque]]) {
        merged[tanque] = cfg[tanque];
      }
    });

    return merged;
  }

  function setSiloProduct(tanque, product) {
    if (!DEFAULT_SILO_PRODUCTS[tanque]) return;
    if (!PRODUCTS[product]) return;

    var cfg = getSiloProducts();
    cfg[tanque] = product;
    writeJson(CONFIG_FILE, cfg);
  }

  // ===== CÁLCULOS =====

  function calculateVolume(level) {
    var safeLevel = Math.max(0, Math.min(MAX_HEIGHT, level));

    if (safeLevel <= CONE_HEIGHT) {
      return V_CONE * Math.pow(safeLevel / CONE_HEIGHT, 3);
    }

    return V_CONE + V_CYL * ((safeLevel - CONE_HEIGHT) / CYL_HEIGHT);
  }

  function getCurrentTotalsFromBackend() {
    var totals = { "DL-5": 0, "VE-03": 0, "ASE": 0 };
    var siloProducts = getSiloProducts();

    Object.keys(latestSilos).forEach(function (tanque) {
      var product = siloProducts[tanque];
      var volume = latestSilos[tanque].volume || 0;
      var ton = (volume * PRODUCTS[product].density) / 1000;
      totals[product] += ton;
    });

    return totals;
  }

  // ===== HISTORIAL PRODUCTOS =====

  function getDefaultHistoryDay() {
    return { "DL-5": [], "VE-03": [], "ASE": [] };
  }

  function getTodayHistory() {
    var allHistory = readJson(HISTORY_FILE, {});
    return allHistory[today()] || getDefaultHistoryDay();
  }

  function getProductHistoryByDate(dateKey) {
    var allHistory = readJson(HISTORY_FILE, {});
    return allHistory[dateKey] || getDefaultHistoryDay();
  }

  function getMonthlyHistory() {
    var allHistory = readJson(HISTORY_FILE, {});
    var result = {};
    var i;
    var key;

    for (i = 29; i >= 0; i--) {
      key = getDateKeyDaysAgo(i);
      result[key] = allHistory[key] || getDefaultHistoryDay();
    }

    return result;
  }

  // ===== HISTORIAL POR SILO (% LLENADO) =====

  function getDefaultSiloHistoryDay() {
    return {
      tanque1: [], tanque2: [], tanque3: [], tanque4: [],
      tanque5: [], tanque6: [], tanque7: [], tanque8: []
    };
  }

  function getTodaySiloHistory() {
    var allHistory = readJson(SILO_HISTORY_FILE, {});
    return allHistory[today()] || getDefaultSiloHistoryDay();
  }

  function getSiloHistoryByDate(dateKey) {
    var allHistory = readJson(SILO_HISTORY_FILE, {});
    return allHistory[dateKey] || getDefaultSiloHistoryDay();
  }

  // ===== GUARDADO HISTÓRICO CADA 5 MIN =====

  function updatePersistentHistory() {
    var allHistory = readJson(HISTORY_FILE, {});
    var siloHistory = readJson(SILO_HISTORY_FILE, {});
    var day = today();
    var label = getRounded5MinLabel();
    var totals = getCurrentTotalsFromBackend();

    if (!allHistory[day]) allHistory[day] = getDefaultHistoryDay();

    Object.keys(totals).forEach(function (product) {
      var arr = allHistory[day][product] || [];
      var lastEntry = arr[arr.length - 1];

      if (!lastEntry) {
        arr.push({ time: label, value: totals[product] });
      } else if (lastEntry.time !== label) {
        arr.push({ time: label, value: totals[product] });
      } else {
        lastEntry.value = totals[product];
      }

      allHistory[day][product] = arr;
    });

    if (!siloHistory[day]) siloHistory[day] = getDefaultSiloHistoryDay();

    Object.keys(latestSilos).forEach(function (tanque) {
      var arr = siloHistory[day][tanque] || [];
      var lastEntry = arr[arr.length - 1];
      var percent = latestSilos[tanque].percent || 0;

      if (!lastEntry) {
        arr.push({ time: label, value: percent });
      } else if (lastEntry.time !== label) {
        arr.push({ time: label, value: percent });
      } else {
        lastEntry.value = percent;
      }

      siloHistory[day][tanque] = arr;
    });

    writeJson(HISTORY_FILE, allHistory);
    writeJson(SILO_HISTORY_FILE, siloHistory);

    io.emit("historyData",   { date: day, history: getTodayHistory() });
    io.emit("siloTrendData", { date: day, history: getTodaySiloHistory() });
  }

  // ===== VARIACIONES DIARIAS =====

  function calculateDailyVariations() {
    var history = getTodayHistory();
    var currentTotals = getCurrentTotalsFromBackend();

    var variations = {
      "DL-5": { positive: 0, negative: 0 },
      "VE-03": { positive: 0, negative: 0 },
      "ASE":  { positive: 0, negative: 0 }
    };

    Object.keys(variations).forEach(function (product) {
      var arr = (history[product] || []).slice();

      arr.sort(function (a, b) {
        return String(a.time).localeCompare(String(b.time));
      });

      var current = Number(currentTotals[product] || 0);
      var last = arr.length > 0 ? Number(arr[arr.length - 1].value) : null;

      if (last == null || Number.isNaN(last)) {
        arr.push({ time: getRounded5MinLabel(), value: current });
      } else if (last !== current) {
        arr.push({ time: getRounded5MinLabel(), value: current });
      }

      for (var i = 1; i < arr.length; i++) {
        var prev = Number(arr[i - 1].value);
        var curr = Number(arr[i].value);

        if (Number.isNaN(prev) || Number.isNaN(curr)) continue;

        var diff = curr - prev;

        if (diff > 0) {
          variations[product].positive += diff;
        } else if (diff < 0) {
          variations[product].negative += Math.abs(diff);
        }
      }
    });

    return variations;
  }

  /**
   * Calcula variaciones de un día histórico a partir de su array de historial.
   * No depende de datos en vivo.
   */
  function calculateVariationsFromHistory(dayHistory) {
    var variations = {
      "DL-5": { positive: 0, negative: 0 },
      "VE-03": { positive: 0, negative: 0 },
      "ASE":  { positive: 0, negative: 0 }
    };

    Object.keys(variations).forEach(function (product) {
      var arr = (dayHistory[product] || []).slice();

      arr.sort(function (a, b) {
        return String(a.time).localeCompare(String(b.time));
      });

      for (var i = 1; i < arr.length; i++) {
        var prev = Number(arr[i - 1].value);
        var curr = Number(arr[i].value);

        if (Number.isNaN(prev) || Number.isNaN(curr)) continue;

        var diff = curr - prev;

        if (diff > 0) {
          variations[product].positive += diff;
        } else if (diff < 0) {
          variations[product].negative += Math.abs(diff);
        }
      }
    });

    return variations;
  }

  // ===== RESUMEN DIARIO (guardado a las 19:00) =====

  function buildDaySummary(dateKey, dayHistory, turnDataForDay, variationsForDay) {
    var summary = { date: dateKey };

    ["DL-5", "VE-03", "ASE"].forEach(function (product) {
      var arr = dayHistory[product] || [];

      var inicio = null;
      var fin    = null;

      if (turnDataForDay && turnDataForDay.start && turnDataForDay.start[product] != null) {
        inicio = Number(turnDataForDay.start[product]);
      } else {
        inicio = getValueNearTime(arr, "07:00");
      }

      if (turnDataForDay && turnDataForDay.end && turnDataForDay.end[product] != null) {
        fin = Number(turnDataForDay.end[product]);
      } else {
        fin = getValueNearTime(arr, "19:00");
      }

      summary[product] = {
        inicio:    inicio != null ? Number(inicio.toFixed(2)) : null,
        fin:       fin    != null ? Number(fin.toFixed(2))    : null,
        varPos:    Number((variationsForDay[product].positive).toFixed(2)),
        varNeg:    Number((variationsForDay[product].negative).toFixed(2))
      };
    });

    return summary;
  }

  function saveDailySummary() {
    var dayKey     = today();
    var dayHistory = getTodayHistory();
    var turnAll    = readJson(TURN_FILE, {});
    var turnDay    = turnAll[dayKey] || {};
    var variations = calculateVariationsFromHistory(dayHistory);

    var summary    = buildDaySummary(dayKey, dayHistory, turnDay, variations);

    var allSummaries = readJson(DAILY_SUMMARY_FILE, {});
    allSummaries[dayKey] = summary;
    writeJson(DAILY_SUMMARY_FILE, allSummaries);

    console.log("[Matriz] Resumen diario guardado para:", dayKey);
    return summary;
  }

  function getLast30DailySummaries() {
    var allSummaries = readJson(DAILY_SUMMARY_FILE, {});
    var allHistory   = readJson(HISTORY_FILE, {});
    var turnAll      = readJson(TURN_FILE, {});
    var result       = [];

    var i;
    for (i = 29; i >= 0; i--) {
      var dateKey = getDateKeyDaysAgo(i);

      if (allSummaries[dateKey]) {
        result.push(allSummaries[dateKey]);
      } else {
        var dayHistory = allHistory[dateKey];
        if (dayHistory) {
          var turnDay    = turnAll[dateKey] || {};
          var variations = calculateVariationsFromHistory(dayHistory);
          var summary    = buildDaySummary(dateKey, dayHistory, turnDay, variations);
          result.push(summary);
        }
      }
    }

    return result;
  }

  // ===== EXPORTACIÓN CSV RESUMEN DIARIO =====

  function buildDailySummaryCsv() {
    var summaries = getLast30DailySummaries();

    var header = [
      "Fecha",
      "DL-5 Inicio 07h (ton)", "DL-5 Fin 19h (ton)", "DL-5 Var.Positiva (ton)", "DL-5 Var.Negativa (ton)",
      "VE-03 Inicio 07h (ton)", "VE-03 Fin 19h (ton)", "VE-03 Var.Positiva (ton)", "VE-03 Var.Negativa (ton)",
      "ASE Inicio 07h (ton)", "ASE Fin 19h (ton)", "ASE Var.Positiva (ton)", "ASE Var.Negativa (ton)"
    ].join(",");

    var rows = summaries.map(function (s) {
      function val(product, field) {
        if (!s[product]) return "";
        var v = s[product][field];
        return v != null ? v : "";
      }

      return [
        s.date,
        val("DL-5",  "inicio"), val("DL-5",  "fin"), val("DL-5",  "varPos"), val("DL-5",  "varNeg"),
        val("VE-03", "inicio"), val("VE-03", "fin"), val("VE-03", "varPos"), val("VE-03", "varNeg"),
        val("ASE",   "inicio"), val("ASE",   "fin"), val("ASE",   "varPos"), val("ASE",   "varNeg")
      ].join(",");
    });

    return header + "\n" + rows.join("\n");
  }

  // ===== EXCEL DIARIO =====

  async function buildExportExcel() {
    if (!fs.existsSync(TEMPLATE_FILE)) {
      throw new Error("No se encontró template.xlsx en la carpeta del proyecto");
    }

    var workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(TEMPLATE_FILE);

    var sheet = workbook.getWorksheet("Hoja1");

    if (!sheet) {
      throw new Error('No se encontró la hoja "Hoja1" en template.xlsx');
    }

    var totals = getCurrentTotalsFromBackend();
    var turn = getTodayTurnData();
    var variations = calculateDailyVariations();
    var siloProducts = getSiloProducts();

    var i, row, tanque, product, volume, massTon;

    sheet.getCell("C4").value = Number(totals["DL-5"].toFixed(1));
    sheet.getCell("D4").value = Number(totals["ASE"].toFixed(1));
    sheet.getCell("E4").value = Number(totals["VE-03"].toFixed(1));

    sheet.getCell("C9").value = turn.start && turn.start["DL-5"] != null
      ? Number(turn.start["DL-5"].toFixed(1)) : "";
    sheet.getCell("D9").value = turn.start && turn.start["ASE"] != null
      ? Number(turn.start["ASE"].toFixed(1)) : "";
    sheet.getCell("E9").value = turn.start && turn.start["VE-03"] != null
      ? Number(turn.start["VE-03"].toFixed(1)) : "";

    sheet.getCell("C10").value = turn.end && turn.end["DL-5"] != null
      ? Number(turn.end["DL-5"].toFixed(1)) : "";
    sheet.getCell("D10").value = turn.end && turn.end["ASE"] != null
      ? Number(turn.end["ASE"].toFixed(1)) : "";
    sheet.getCell("E10").value = turn.end && turn.end["VE-03"] != null
      ? Number(turn.end["VE-03"].toFixed(1)) : "";

    sheet.getCell("C11").value = Number(variations["DL-5"].positive.toFixed(1));
    sheet.getCell("D11").value = Number(variations["ASE"].positive.toFixed(1));
    sheet.getCell("E11").value = Number(variations["VE-03"].positive.toFixed(1));

    sheet.getCell("C12").value = Number(variations["DL-5"].negative.toFixed(1));
    sheet.getCell("D12").value = Number(variations["ASE"].negative.toFixed(1));
    sheet.getCell("E12").value = Number(variations["VE-03"].negative.toFixed(1));

    for (i = 1; i <= 8; i++) {
      row = 16 + i;
      tanque = "tanque" + i;
      product = siloProducts[tanque];
      volume = latestSilos[tanque] ? latestSilos[tanque].volume || 0 : 0;
      massTon = (volume * PRODUCTS[product].density) / 1000;

      sheet.getCell("C" + row).value = product;
      sheet.getCell("D" + row).value = Number(massTon.toFixed(2));
    }

    var fileName = "stock_diario_" + formatDateYYYYMMDD() + ".xlsx";
    var filePath = path.join(EXPORTS_DIR, fileName);

    await workbook.xlsx.writeFile(filePath);

    return { fileName: fileName, filePath: filePath };
  }

  // ===== MQTT =====

  var MQTT_URL   = process.env.MQTT_URL_MATRIZ || process.env.MQTT_URL || "mqtt://localhost:1883";
  var MQTT_TOPIC = process.env.MQTT_TOPIC_MATRIZ || "planta/losbronces/silos/#";

  var client = mqtt.connect(MQTT_URL);

  client.on("connect", function () {
    console.log("[Matriz] MQTT conectado:", MQTT_URL, MQTT_TOPIC);
    client.subscribe(MQTT_TOPIC);
  });

  client.on("error", function (error) {
    console.error("[Matriz] Error MQTT:", error.message);
  });

  client.on("message", function (topic, message) {
    try {
      var parts = topic.split("/");
      var tanque = parts[parts.length - 1];
      var payload, rawValue, rawUint32, sensorDistance, level, volume, percent;

      if (!latestSilos[tanque]) return;

      payload  = JSON.parse(message.toString());
      rawValue = extractDeltaRawValue(payload);
      if (rawValue == null) return;

      rawUint32 = parseInt(rawValue, 10);
      if (Number.isNaN(rawUint32)) return;

      sensorDistance = uint32ToFloatWordSwap(rawUint32);
      if (Number.isNaN(sensorDistance) || !Number.isFinite(sensorDistance)) return;

      sensorDistance = sensorDistance * 0.98;
      sensorDistance = Math.max(0, Math.min(MAX_HEIGHT, sensorDistance));

      level   = MAX_HEIGHT - sensorDistance;
      level   = Math.max(0, Math.min(MAX_HEIGHT, level));
      volume  = calculateVolume(level);
      percent = (level / MAX_HEIGHT) * 100;

      latestSilos[tanque] = { levelMeters: level, volume: volume, percent: percent };

      io.emit("nivel",     { tanque: tanque, nivel: String(sensorDistance), serverTime: getServerTime() });
      io.emit("siloState", latestSilos);

      console.log(
        "[Matriz] MQTT recibido:", tanque,
        "distance_m=" + sensorDistance.toFixed(3),
        "level_m=" + level.toFixed(3),
        "percent=" + percent.toFixed(2)
      );
    } catch (error) {
      console.error("[Matriz] Error procesando MQTT:", error, message.toString());
    }
  });

  // ===== TURNOS =====

  function checkShift() {
    var h = new Date().getHours();
    var d = readJson(TURN_FILE, {});
    var t = today();
    var totals = getCurrentTotalsFromBackend();

    if (!d[t]) d[t] = {};

    if (h >= 7 && !d[t].start) {
      d[t].start = totals;
    }

    if (h >= 19 && !d[t].end) {
      d[t].end = totals;
    }

    writeJson(TURN_FILE, d);
    io.emit("turnData", d[t] || {});
  }

  function getTodayTurnData() {
    var data = readJson(TURN_FILE, {});
    return data[today()] || {};
  }

  // ===== TAREA: GUARDADO AUTOMÁTICO DEL RESUMEN DIARIO A LAS 19:00 =====

  var dailySummarySavedToday = false;

  function checkDailySummaryTrigger() {
    var now = new Date();
    var h   = now.getHours();
    var m   = now.getMinutes();
    var d   = today();

    if (h === 19 && m < 5) {
      if (!dailySummarySavedToday) {
        saveDailySummary();
        dailySummarySavedToday = true;
        console.log("[Matriz] Resumen diario guardado automáticamente para:", d);
      }
    } else {
      if (h !== 19 || m >= 5) {
        dailySummarySavedToday = false;
      }
    }
  }

  // ===== INTERVALOS =====

  setInterval(checkShift, 60000);
  setInterval(updatePersistentHistory, 60000);
  setInterval(checkDailySummaryTrigger, 60000);

  // ===== RUTAS HTTP (solo usuario Admin) =====

  async function handleExportData(req, res) {
    try {
      var exportFile = await buildExportExcel();
      return res.download(exportFile.filePath, exportFile.fileName);
    } catch (error) {
      console.error("[Matriz] Error generando Excel:", error);
      return res.status(500).send("No fue posible generar el archivo Excel");
    }
  }

  function handleExportDailySummary(req, res) {
    try {
      var csv      = buildDailySummaryCsv();
      var fileName = "historial_" + formatDateYYYYMMDD() + ".csv";

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=" + fileName);
      return res.send(csv);
    } catch (error) {
      console.error("[Matriz] Error generando CSV resumen diario:", error);
      return res.status(500).send("No fue posible generar el archivo CSV");
    }
  }

  app.get("/matriz/export-data", requireAdmin, handleExportData);
  app.get("/matriz/export-daily-summary", requireAdmin, handleExportDailySummary);
  app.get("/matriz/export-trend", requireAdmin, function (req, res) {
    return res.redirect("/matriz/export-daily-summary");
  });

  // Rutas antiguas (compatibilidad con enlaces/marcadores existentes)
  app.get("/export-data", requireAdmin, handleExportData);
  app.get("/export-daily-summary", requireAdmin, handleExportDailySummary);
  app.get("/export-trend", requireAdmin, function (req, res) {
    return res.redirect("/matriz/export-daily-summary");
  });

  // ===== SOCKET (namespace /matriz) =====

  io.on("connection", function (socket) {
    var username = socket.handshake.session && socket.handshake.session.user;

    // Si no hay sesión válida, se rechaza la conexión del socket
    if (!username) {
      socket.disconnect(true);
      return;
    }

    socket.on("getTurnData", function (payload) {
      var data    = readJson(TURN_FILE, {});
      var dateKey = payload && payload.date ? payload.date : today();

      socket.emit("turnData", {
        date: dateKey,
        data: data[dateKey] || {}
      });
    });

    socket.on("getSiloConfig", function () {
      socket.emit("siloConfig", getSiloProducts());
    });

    socket.on("setSiloProduct", function (payload) {
      if (!payload) return;
      setSiloProduct(payload.tanque, payload.product);
      io.emit("siloConfig", getSiloProducts());
    });

    socket.on("getHistoryDates", function () {
      socket.emit("historyDates", getLast30DateKeys());
    });

    socket.on("getHistoryData", function (payload) {
      var dateKey = payload && payload.date ? payload.date : today();
      socket.emit("historyData", {
        date:    dateKey,
        history: getProductHistoryByDate(dateKey)
      });
    });

    socket.on("getSiloTrendData", function (payload) {
      var dateKey = payload && payload.date ? payload.date : today();
      socket.emit("siloTrendData", {
        date:    dateKey,
        history: getSiloHistoryByDate(dateKey)
      });
    });

    socket.on("getSiloState", function () {
      socket.emit("siloState", latestSilos);
    });
  });

  return {
    latestSilos: latestSilos,
    calculateVolume: calculateVolume,
    getCurrentTotalsFromBackend: getCurrentTotalsFromBackend,
    getMonthlyHistory: getMonthlyHistory,
    saveDailySummary: saveDailySummary
  };
};

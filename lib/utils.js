// ===== UTILIDADES COMPARTIDAS (Matriz + Nitrato) =====
// Funciones que eran idénticas en ambos proyectos originales.

const fs = require("fs");

// ===== ARCHIVOS =====

function ensureJsonFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

function readJson(filePath, fallback) {
  try {
    ensureJsonFile(filePath, fallback);
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ===== TIEMPO LOCAL =====

function pad2(n) {
  return String(n).padStart(2, "0");
}

function today() {
  var now = new Date();
  return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
}

function formatDateYYYYMMDD(dateObj) {
  var date = dateObj || new Date();
  return date.getFullYear() + pad2(date.getMonth() + 1) + pad2(date.getDate());
}

function getDateKeyDaysAgo(daysAgo) {
  var date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
}

function getRounded5MinLabel() {
  var now = new Date();
  var rounded = Math.floor(now.getMinutes() / 5) * 5;
  return pad2(now.getHours()) + ":" + pad2(rounded);
}

function getServerTime() {
  return new Date().toLocaleTimeString("es-CL", { hour12: false });
}

function getLast30DateKeys() {
  var dates = [];
  for (var i = 29; i >= 0; i--) {
    dates.push(getDateKeyDaysAgo(i));
  }
  return dates;
}

// ===== RESUMEN DIARIO =====

function getValueNearTime(historyArr, targetTime) {
  if (!historyArr || historyArr.length === 0) return null;

  var exact = historyArr.find(function (item) {
    return item.time === targetTime;
  });
  if (exact) return Number(exact.value);

  var parts = targetTime.split(":");
  var targetMinutes = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);

  var best = null;
  var bestDiff = Infinity;

  historyArr.forEach(function (item) {
    var tp = item.time.split(":");
    var itemMinutes = parseInt(tp[0], 10) * 60 + parseInt(tp[1], 10);
    var diff = Math.abs(itemMinutes - targetMinutes);

    if (diff <= 30 && diff < bestDiff) {
      bestDiff = diff;
      best = Number(item.value);
    }
  });

  return best;
}

// ===== MQTT (Delta HMI) =====

function uint32ToFloatWordSwap(uintValue) {
  var buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(uintValue >>> 0, 0);

  var swapped = Buffer.from([buffer[2], buffer[3], buffer[0], buffer[1]]);
  return swapped.readFloatBE(0);
}

function extractDeltaRawValue(payload) {
  var key;
  if (!payload || !payload.d) return null;

  for (key in payload.d) {
    if (key !== "type") return payload.d[key];
  }
  return null;
}

module.exports = {
  ensureJsonFile,
  readJson,
  writeJson,
  pad2,
  today,
  formatDateYYYYMMDD,
  getDateKeyDaysAgo,
  getRounded5MinLabel,
  getServerTime,
  getLast30DateKeys,
  getValueNearTime,
  uint32ToFloatWordSwap,
  extractDeltaRawValue
};

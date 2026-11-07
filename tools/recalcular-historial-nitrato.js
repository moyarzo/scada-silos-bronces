#!/usr/bin/env node
// ===== RECÁLCULO DEL HISTORIAL DE NITRATO AL MODELO ACTUAL =====
//
// Los puntos del historial guardados antes de actualizar el modelo de cálculo (geometría de la
// planilla, 05-11-2026) quedaron con el modelo anterior. Esta herramienta los convierte:
//
//   % llenado guardado (modelo anterior) → volumen anterior → lectura de radar original
//   → nivel / volumen / % / toneladas con el modelo actual (lib/nitrato-model.js)
//
// Archivos que actualiza (con respaldo previo en backups/):
//   nitrato_siloHistoryData.json  (% por silo cada 5 min)
//   nitrato_historyData.json      (totalizador cada 5 min, se recalcula desde los silos)
//   nitrato_turnData.json         (registro de turno 07h / 19h)
//   nitrato_dailySummary.json     (se borran los días recalculados; el servidor los rehace solo)
//   nitrato_recalculo.json        (registro de días ya recalculados: evita convertirlos dos veces)
//
// USO (desde la carpeta del proyecto, con el servidor detenido):
//   node tools/recalcular-historial-nitrato.js                 → simulación: muestra cambios, no escribe
//   node tools/recalcular-historial-nitrato.js --aplicar       → aplica los cambios
//
// Opciones:
//   --corte "AAAA-MM-DD HH:MM"  Momento en que empezó a correr el modelo nuevo. Si no se indica,
//                               se busca en logs/out.log (primera línea "volumen total 83.34").
//   --dias N                    Además del día del corte, recalcula completos los N días anteriores.
//   --todo                      Recalcula todos los días anteriores al corte (desde el 26-10-2026,
//                               inicio del sistema integrado; antes regía otro modelo).

const fs = require("fs");
const path = require("path");
const { createNitratoModel } = require("../lib/nitrato-model");

const BASE_DIR = path.join(__dirname, "..");
const FILES = {
  silo:    path.join(BASE_DIR, "nitrato_siloHistoryData.json"),
  history: path.join(BASE_DIR, "nitrato_historyData.json"),
  turn:    path.join(BASE_DIR, "nitrato_turnData.json"),
  summary: path.join(BASE_DIR, "nitrato_dailySummary.json"),
  marker:  path.join(BASE_DIR, "nitrato_recalculo.json")
};

// Desde esta fecha corría el modelo "anterior" (sistema integrado). Antes regía otro cálculo.
const MIN_DATE = "2026-10-26";

// ===== ARGUMENTOS =====

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const APPLY    = args.includes("--aplicar");
const ALL_DAYS = args.includes("--todo");
const EXTRA_DAYS = Number(argValue("--dias") || 0);

// ===== MODELO NUEVO (el mismo que usa el servidor) =====

const NEW = createNitratoModel();
const DENSITY = NEW.PRODUCTS["Nitrato"].density;

// ===== MODELO ANTERIOR (copia exacta del que corría hasta el 05-11-2026, commit 8d21588) =====

const OLD = (function () {
  const N_TOLVA_HEIGHT = 0.78, N_CYL_HEIGHT = 5.95, N_MAX_HEIGHT = 6.73;
  const N_A_INF = 2.78, N_A_SUP = 3.48, N_B = (N_A_SUP - N_A_INF) / N_TOLVA_HEIGHT;
  const N_V_TOLVA = 7.6734;
  const N_V_TOTAL = N_V_TOLVA + N_A_SUP * N_A_SUP * N_CYL_HEIGHT;   // 79.73 m³
  const RADAR_TABLE = [
    { radar: 0.34, lidarProm: 0.30 }, { radar: 0.91, lidarProm: 1.05 }, { radar: 1.16, lidarProm: 1.22 },
    { radar: 2.23, lidarProm: 2.35 }, { radar: 2.33, lidarProm: 2.42 }, { radar: 2.52, lidarProm: 2.68 },
    { radar: 4.05, lidarProm: 5.59 }
  ].map(p => ({ radar: p.radar, level: N_MAX_HEIGHT - p.lidarProm }));
  const RADAR_EMPTY_DIST = 7.05, RADAR_EMPTY_LEVEL = 0.088;
  const MASA_VACIO_TON = 0.10, OLD_DENSITY = 750;

  const lerp = (x, x0, y0, x1, y1) => x1 === x0 ? y0 : y0 + (y1 - y0) * (x - x0) / (x1 - x0);

  function calculateVolume(level) {
    const s = Math.max(0, Math.min(N_MAX_HEIGHT, level));
    if (s <= N_TOLVA_HEIGHT) return (Math.pow(N_A_INF + N_B * s, 3) - Math.pow(N_A_INF, 3)) / (3 * N_B);
    return N_V_TOLVA + N_A_SUP * N_A_SUP * (s - N_TOLVA_HEIGHT);
  }
  // Ajuste de tolva vigente desde el 04-11-2026 (commit 8d21588)
  function tolvaFactor(level) {
    if (level >= N_TOLVA_HEIGHT) return 1;
    const fEmpty = Math.max(0, Math.min(1, ((MASA_VACIO_TON * 1000) / OLD_DENSITY) / calculateVolume(RADAR_EMPTY_LEVEL)));
    if (level <= RADAR_EMPTY_LEVEL) return fEmpty;
    return lerp(level, RADAR_EMPTY_LEVEL, fEmpty, N_TOLVA_HEIGHT, 1);
  }
  function levelFromRadar(dist) {
    const t = RADAR_TABLE, first = t[0], last = t[t.length - 1];
    if (dist <= first.radar) return lerp(dist, t[0].radar, t[0].level, t[1].radar, t[1].level);
    if (dist <= last.radar) {
      let i = 0;
      while (i < t.length - 2 && dist > t[i + 1].radar) i++;
      return lerp(dist, t[i].radar, t[i].level, t[i + 1].radar, t[i + 1].level);
    }
    if (dist < RADAR_EMPTY_DIST) return lerp(dist, last.radar, last.level, RADAR_EMPTY_DIST, RADAR_EMPTY_LEVEL);
    return RADAR_EMPTY_LEVEL;
  }
  function volumeFromRadar(radar, withTolvaFix) {
    const level = Math.max(0, Math.min(N_MAX_HEIGHT, levelFromRadar(radar)));
    return calculateVolume(level) * (withTolvaFix ? tolvaFactor(level) : 1);
  }
  return { N_V_TOTAL, volumeFromRadar };
})();

// Lectura de radar que produjo un % del modelo anterior (búsqueda binaria; el volumen baja al subir la distancia)
function radarFromOldPercent(percent, withTolvaFix) {
  const target = (percent / 100) * OLD.N_V_TOTAL;
  let lo = 0, hi = 10;
  if (target >= OLD.volumeFromRadar(lo, withTolvaFix)) return lo;
  if (target <= OLD.volumeFromRadar(hi, withTolvaFix)) return hi;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (OLD.volumeFromRadar(mid, withTolvaFix) > target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function convertPercent(oldPercent, dateKey) {
  const p = Number(oldPercent);
  if (!p || isNaN(p)) return { percent: p || 0, volume: 0 };     // 0 = silo sin datos: se mantiene
  const radar  = radarFromOldPercent(p, dateKey >= "2026-11-04");
  const level  = NEW.levelFromRadar(radar).level;
  const volume = NEW.calculateVolume(level);
  return { percent: (volume / NEW.N_V_TOTAL) * 100, volume, radar };
}

// ===== MOMENTO DE CORTE =====

function pad2(n) { return String(n).padStart(2, "0"); }

function findCutover() {
  const manual = argValue("--corte");
  if (manual) return manual.trim();
  const candidates = [
    path.join(BASE_DIR, "logs", "out.log"),                                       // ecosystem.config.js
    path.join(process.env.HOME || "", ".pm2", "logs", "scada-silos-out.log")       // ruta por defecto de PM2
  ];
  for (const logFile of candidates) {
    if (!fs.existsSync(logFile)) continue;
    const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/);
    const line = lines.find(l => l.includes("volumen total 83.34"));
    const m = line && line.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    if (m) return m[1] + " " + m[2];
  }
  return null;
}

const cut = findCutover();
if (!cut || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(cut)) {
  console.error("No se encontró el momento en que empezó el modelo nuevo.");
  console.error('Indícalo con:  --corte "AAAA-MM-DD HH:MM"   (hora del pm2 restart tras el git pull)');
  process.exit(1);
}
const CUT_DATE = cut.slice(0, 10);
const [ch, cm] = cut.slice(11).split(":").map(Number);
// El bloque de 5 min donde ocurrió el reinicio ya quedó escrito con el modelo nuevo
const CUT_LABEL = pad2(ch) + ":" + pad2(Math.floor(cm / 5) * 5);

function isOldPoint(dateKey, label) {
  if (dateKey < MIN_DATE) return false;
  if (DONE[dateKey] && DONE[dateKey] >= (dateKey === CUT_DATE ? CUT_LABEL : "24:00")) return false;
  if (dateKey > CUT_DATE) return false;
  if (dateKey === CUT_DATE) return label < CUT_LABEL;
  if (ALL_DAYS) return true;
  const d = new Date(CUT_DATE + "T12:00:00");
  d.setDate(d.getDate() - EXTRA_DAYS);
  const limit = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  return dateKey >= limit;
}

// ===== LECTURA =====

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return {}; }
}

const siloAll    = readJson(FILES.silo);
const historyAll = readJson(FILES.history);
const turnAll    = readJson(FILES.turn);
const summaryAll = readJson(FILES.summary);
const markerAll  = readJson(FILES.marker);
// Días ya recalculados: { "AAAA-MM-DD": "HH:MM" (hasta qué bloque se convirtió) }
const DONE = markerAll.dias || {};

console.log("Modelo nuevo desde: " + CUT_DATE + " " + CUT_LABEL + "  (puntos anteriores se recalculan)");
console.log("Días incluidos: " + (ALL_DAYS ? "todos los anteriores + " : EXTRA_DAYS ? EXTRA_DAYS + " anteriores + " : "") + CUT_DATE);
console.log("Modo: " + (APPLY ? "APLICAR" : "SIMULACIÓN (no se escribe nada; usar --aplicar)"));
console.log("");

const daysTouched = [];
let pointsSilo = 0, pointsTotal = 0;

Object.keys(siloAll).sort().forEach(dateKey => {
  const day = siloAll[dateKey] || {};
  const labelsOld = new Set();
  Object.keys(day).forEach(t => (day[t] || []).forEach(p => { if (isOldPoint(dateKey, p.time)) labelsOld.add(p.time); }));
  if (labelsOld.size === 0) return;
  daysTouched.push(dateKey);

  // 1) % por silo  +  masa nueva por silo y bloque
  const newMassByLabel = {};
  const oldMassByLabel = {};
  Object.keys(day).forEach(tanque => {
    (day[tanque] || []).forEach(p => {
      if (!isOldPoint(dateKey, p.time)) return;
      const oldPct = Number(p.value) || 0;
      const conv = convertPercent(oldPct, dateKey);
      oldMassByLabel[p.time] = (oldMassByLabel[p.time] || 0) + (oldPct / 100) * OLD.N_V_TOTAL * 0.75;
      newMassByLabel[p.time] = (newMassByLabel[p.time] || 0) + conv.volume * DENSITY / 1000;
      p.value = conv.percent;
      pointsSilo++;
    });
  });

  // 2) Totalizador: se recalcula desde los silos del mismo bloque
  const hist = (historyAll[dateKey] && historyAll[dateKey]["Nitrato"]) || [];
  const changes = [];
  hist.forEach(p => {
    if (!isOldPoint(dateKey, p.time)) return;
    if (newMassByLabel[p.time] == null) return;     // sin dato por silo para ese bloque: se deja igual
    changes.push({ time: p.time, before: Number(p.value), after: newMassByLabel[p.time] });
    p.value = newMassByLabel[p.time];
    pointsTotal++;
  });

  // 3) Registro de turno (07h / 19h): mismo factor que el bloque más cercano con valor similar
  const turn = turnAll[dateKey];
  ["start", "end"].forEach(key => {
    if (!turn || !turn[key] || turn[key]["Nitrato"] == null) return;
    const target = key === "start" ? "07:00" : "19:00";
    if (!isOldPoint(dateKey, target)) return;
    const oldVal = Number(turn[key]["Nitrato"]);
    let best = null, bestDiff = Infinity;
    changes.forEach(c => {
      const tm = c.time.split(":").map(Number), tg = target.split(":").map(Number);
      const dt = Math.abs((tm[0] * 60 + tm[1]) - (tg[0] * 60 + tg[1]));
      const dv = Math.abs(c.before - oldVal);
      if (dt <= 60 && dv + dt / 1000 < bestDiff) { bestDiff = dv + dt / 1000; best = c; }
    });
    if (best && best.before > 0) {
      const after = oldVal * (best.after / best.before);
      console.log(`  ${dateKey} turno ${target}: ${oldVal.toFixed(2)} t → ${after.toFixed(2)} t`);
      turn[key]["Nitrato"] = after;
    } else if (best && best.before === 0) {
      // sin masa en ese momento: se mantiene
    }
  });

  // 4) Resumen diario: se borra para que el servidor lo recalcule con el historial corregido
  if (summaryAll[dateKey]) delete summaryAll[dateKey];

  // Muestra compacta: solo cuando cambia el valor
  console.log(`  ${dateKey}: ${changes.length} puntos del totalizador recalculados`);
  let lastKey = null;
  changes.forEach((c, i) => {
    const key = c.before.toFixed(2) + "|" + c.after.toFixed(2);
    const next = changes[i + 1];
    if (key !== lastKey || !next) {
      console.log(`     ${c.time}   ${c.before.toFixed(2)} t → ${c.after.toFixed(2)} t`);
      lastKey = key;
    }
  });
});

if (daysTouched.length === 0) {
  console.log("No hay puntos pendientes de recalcular (los días ya procesados están en nitrato_recalculo.json).");
  process.exit(0);
}

console.log("");
console.log(`Total: ${pointsSilo} puntos por silo y ${pointsTotal} del totalizador en ${daysTouched.length} día(s).`);

if (!APPLY) {
  console.log("Simulación terminada. Para aplicar:  node tools/recalcular-historial-nitrato.js --aplicar" +
    (argValue("--corte") ? ' --corte "' + cut + '"' : "") + (EXTRA_DAYS ? " --dias " + EXTRA_DAYS : "") + (ALL_DAYS ? " --todo" : ""));
  process.exit(0);
}

// ===== RESPALDO Y ESCRITURA =====

const now = new Date();
const stamp = now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) + "-" +
  pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
const backupDir = path.join(BASE_DIR, "backups", "historial-nitrato-" + stamp);
fs.mkdirSync(backupDir, { recursive: true });
Object.values(FILES).forEach(f => { if (fs.existsSync(f)) fs.copyFileSync(f, path.join(backupDir, path.basename(f))); });

fs.writeFileSync(FILES.silo,    JSON.stringify(siloAll, null, 2));
fs.writeFileSync(FILES.history, JSON.stringify(historyAll, null, 2));
fs.writeFileSync(FILES.turn,    JSON.stringify(turnAll, null, 2));
fs.writeFileSync(FILES.summary, JSON.stringify(summaryAll, null, 2));
daysTouched.forEach(d => { DONE[d] = d === CUT_DATE ? CUT_LABEL : "24:00"; });
fs.writeFileSync(FILES.marker, JSON.stringify({ modelo: "planilla-2026-11-05", corte: cut, dias: DONE }, null, 2));

// Bitácora (pestaña Eventos, categoría Operación)
try {
  const ev = require("../lib/eventos");
  ev.appendEventToFile(BASE_DIR, { ts: ev.stamp(new Date()), cat: "operacion", sev: "info",
    tipo: "Recálculo de historial", sistema: "Nitrato", silo: null, usuario: null, ip: null,
    detalle: daysTouched.length + " día(s): " + daysTouched.join(", ") + " · " + pointsSilo + " puntos por silo · respaldo en " +
      path.relative(BASE_DIR, backupDir) });
} catch (e) { console.warn("No se pudo registrar el evento en la bitácora:", e.message); }

console.log("Cambios aplicados. Respaldo de los archivos originales en: " + backupDir);
console.log("Para deshacer:  cp " + path.relative(BASE_DIR, backupDir) + "/*.json .   (con el servidor detenido)");

// ===== BITÁCORA DE EVENTOS =====
//
// Registra con fecha y hora lo relevante del sistema:
//   usuarios        → inicio / cierre de sesión, login fallido, conexión / desconexión, descargas,
//                     cambio de producto, modo DEMO / REAL                         (solo Admin)
//   comunicaciones  → servidor iniciado / detenido, broker MQTT, silo sin datos, HMI sin datos
//   proceso         → recargas, saltos, lecturas falsas, lecturas fuera de rango, ruido del radar elevado
//   operacion       → registro de turno, resumen diario, recálculo de historial, disco casi lleno (solo Admin)
//
// Almacenamiento: un archivo por mes, eventos/eventos_AAAA-MM.jsonl (una línea JSON por evento, solo se
// agregan líneas: robusto ante cortes). Se conservan EVENTOS_RETENCION_DIAS (90 días = 3 meses).
// Los archivos no están en Git: "git pull" no los toca.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const ExcelJS = require("exceljs");
const { analyzeDay } = require("./kpi");

const RETENTION_DAYS   = Number(process.env.EVENTOS_RETENCION_DIAS || 90);
const SILENT_MIN       = Number(process.env.EVENTOS_SIN_DATOS_MIN || 10);   // silo / HMI sin datos
const DISK_WARN_PCT    = Number(process.env.EVENTOS_DISCO_PCT || 85);
const SETTLE_MIN       = 60;    // un salto se registra 60 min después (para saber si fue lectura falsa)
const MAX_VALID_PCT    = 99.5;  // igual que lib/kpi.js
const JUMP_PCT         = Number(process.env.KPI_SALTO_PCT || 10);
const MAX_JUMPS_PER_DAY = 3;    // saltos / lecturas falsas por silo y día; luego un solo aviso "Saltos frecuentes"

const CATEGORIES = ["usuarios", "comunicaciones", "proceso", "operacion"];
const PUBLIC_CATEGORIES = ["comunicaciones", "proceso"];   // visibles para usuarios no Admin
const SISTEMA_NAME = { matriz: "Matriz", nitrato: "Nitrato" };

function pad2(n) { return String(n).padStart(2, "0"); }
function dayKeyOf(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function stamp(d) {
  return dayKeyOf(d) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}
function stampFromMin(dayKey, min) { return dayKey + " " + pad2(Math.floor(min / 60)) + ":" + pad2(min % 60) + ":00"; }
function parseStamp(ts) { return new Date(ts.replace(" ", "T")); }

function fmtNum(v, dec) {
  return Number(v).toLocaleString("es-CL", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 1) return Math.max(1, Math.round(ms / 1000)) + " s";
  if (totalMin < 60) return totalMin + " min";
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  if (h < 24) return h + " h" + (m ? " " + m + " min" : "");
  const d = Math.floor(h / 24);
  return d + " d " + (h % 24) + " h";
}

function siloName(sistema, tanque) {
  return "Silo " + String(tanque).replace("tanque", "") + " " + SISTEMA_NAME[sistema];
}

function cleanIp(ip) {
  return String(ip || "").split(",")[0].trim().replace(/^::ffff:/, "") || "—";
}

// Resumen corto del navegador: "Chrome / Windows"
function describeAgent(ua) {
  ua = String(ua || "");
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return browser + (os ? " / " + os : "");
}

// ===== ESCRITURA DIRECTA (también la usan las herramientas de tools/, con el servidor detenido) =====

function eventsDir(baseDir) { return path.join(baseDir, "eventos"); }

function appendEventToFile(baseDir, ev) {
  const dir = eventsDir(baseDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "eventos_" + ev.ts.slice(0, 7) + ".jsonl"), JSON.stringify(ev) + "\n");
}

function createEventLog(options) {
  const BASE_DIR = options.baseDir;
  const DIR = eventsDir(BASE_DIR);
  const isAdmin = options.isAdmin;
  let io = null;                       // namespace principal (se asigna con attachSocket)

  let events = [];                     // últimos 3 meses en memoria, orden cronológico
  let seq = 0;

  // ===== CARGA Y RETENCIÓN =====

  function cutoffStamp() {
    const d = new Date(); d.setDate(d.getDate() - RETENTION_DAYS); d.setHours(0, 0, 0, 0);
    return stamp(d);
  }

  function loadEvents() {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    const cutoff = cutoffStamp();
    const files = fs.readdirSync(DIR).filter(f => /^eventos_\d{4}-\d{2}\.jsonl$/.test(f)).sort();
    const loaded = [];
    files.forEach(f => {
      if (f.slice(8, 15) < cutoff.slice(0, 7)) return;
      fs.readFileSync(path.join(DIR, f), "utf8").split("\n").forEach(line => {
        if (!line.trim()) return;
        try {
          const ev = JSON.parse(line);
          if (ev && ev.ts && ev.ts >= cutoff) loaded.push(ev);
        } catch (e) { /* línea incompleta (corte de energía al escribir): se ignora */ }
      });
    });
    loaded.sort((a, b) => a.ts.localeCompare(b.ts));
    loaded.forEach(ev => { ev.id = "e" + (++seq); });   // id solo en memoria (destello de eventos nuevos)
    events = loaded;
  }

  function applyRetention() {
    const cutoff = cutoffStamp();
    events = events.filter(ev => ev.ts >= cutoff);
    if (!fs.existsSync(DIR)) return;
    fs.readdirSync(DIR).forEach(f => {
      const m = /^eventos_(\d{4}-\d{2})\.jsonl$/.exec(f);
      if (m && m[1] < cutoff.slice(0, 7)) {
        try { fs.unlinkSync(path.join(DIR, f)); console.log("[Eventos] Archivo antiguo eliminado:", f); }
        catch (e) { console.error("[Eventos] No se pudo eliminar", f, e.message); }
      }
    });
  }

  // ===== REGISTRO =====

  /**
   * cat: usuarios | comunicaciones | proceso | operacion   ·   sev: info | aviso | alarma
   * extra: { sistema, silo, usuario, ip, detalle, ts (Date o "AAAA-MM-DD HH:MM:SS") }
   */
  function log(cat, sev, tipo, extra) {
    extra = extra || {};
    const ts = extra.ts instanceof Date ? stamp(extra.ts) : (extra.ts || stamp(new Date()));
    const ev = {
      id: "e" + (++seq), ts, cat, sev, tipo,
      sistema: extra.sistema ? SISTEMA_NAME[extra.sistema] || extra.sistema : null,
      silo: extra.silo || null,
      usuario: extra.usuario || null,
      ip: extra.ip || null,
      detalle: extra.detalle || ""
    };
    try {
      const saved = Object.assign({}, ev);
      delete saved.id;
      appendEventToFile(BASE_DIR, saved);
    } catch (e) {
      console.error("[Eventos] No se pudo guardar el evento:", e.message);
    }
    // Inserción ordenada (los eventos de proceso pueden llegar con hora pasada)
    let i = events.length;
    while (i > 0 && events[i - 1].ts > ev.ts) i--;
    events.splice(i, 0, ev);

    if (io) {
      io.to("eventos-admin").emit("evento", ev);
      if (PUBLIC_CATEGORIES.indexOf(cat) >= 0) io.to("eventos-usuarios").emit("evento", ev);
    }
    return ev;
  }

  function hasSimilar(cat, tipo, silo, ts, toleranceMin) {
    const t = parseStamp(ts).getTime(), tol = toleranceMin * 60000;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.cat === cat && ev.tipo === tipo && ev.silo === silo && Math.abs(parseStamp(ev.ts).getTime() - t) <= tol) return true;
    }
    return false;
  }

  // ===== CONSULTA =====

  function visibleFor(admin) {
    return admin ? events : events.filter(ev => PUBLIC_CATEGORIES.indexOf(ev.cat) >= 0);
  }

  function matches(ev, f, ignoreCat) {
    const k = ev.ts.slice(0, 10);
    if (f.desde && k < f.desde) return false;
    if (f.hasta && k > f.hasta) return false;
    if (!ignoreCat && f.cat && ev.cat !== f.cat) return false;
    if (f.sev && ev.sev !== f.sev) return false;
    if (f.silo && ev.silo !== f.silo) return false;
    if (f.usuario && ev.usuario !== f.usuario) return false;
    if (f.q) {
      const text = [ev.tipo, ev.detalle, ev.silo, ev.usuario, ev.ip, ev.sistema].join(" ").toLowerCase();
      if (text.indexOf(f.q) < 0) return false;
    }
    return true;
  }

  function readFilters(query, admin) {
    const s = v => (typeof v === "string" ? v.trim() : "");
    const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(s(v)) ? s(v) : "");
    return {
      desde: date(query.desde), hasta: date(query.hasta),
      cat: CATEGORIES.indexOf(s(query.cat)) >= 0 ? s(query.cat) : "",
      sev: ["info", "aviso", "alarma"].indexOf(s(query.sev)) >= 0 ? s(query.sev) : "",
      silo: s(query.silo), usuario: admin ? s(query.usuario) : "",
      q: s(query.q).toLowerCase()
    };
  }

  function strip(ev, admin) {
    if (admin) return ev;
    const out = Object.assign({}, ev);
    delete out.usuario; delete out.ip;
    return out;
  }

  function query(q, admin) {
    const f = readFilters(q, admin);
    const base = visibleFor(admin);
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 50));
    const offset = Math.max(0, Number(q.offset) || 0);

    const counts = { "": 0 };
    const rows = [];
    for (let i = base.length - 1; i >= 0; i--) {           // más recientes primero
      const ev = base[i];
      if (!matches(ev, f, true)) continue;
      counts[""]++;
      counts[ev.cat] = (counts[ev.cat] || 0) + 1;
      if (!f.cat || ev.cat === f.cat) rows.push(ev);
    }

    const silos = Array.from(new Set(base.map(ev => ev.silo).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
    const usuarios = admin ? Array.from(new Set(base.map(ev => ev.usuario).filter(Boolean))).sort() : [];

    return {
      eventos: rows.slice(offset, offset + limit).map(ev => strip(ev, admin)),
      total: rows.length, counts, silos, usuarios,
      categorias: admin ? CATEGORIES : PUBLIC_CATEGORIES,
      retencionDias: RETENTION_DAYS,
      resumen: summary(admin)
    };
  }

  function filteredForExport(q) {
    const f = readFilters(q, true);
    return events.filter(ev => matches(ev, f, false)).reverse();
  }

  // ===== MONITOREO DE COMUNICACIONES (silo / HMI sin datos, broker MQTT) =====

  const startedAt = Date.now();
  const silos = {};          // "matriz:tanque1" → { sistema, tanque, lastSeen, silentSince, outSince, lastOutLog }
  const brokers = {};        // url → { connected, since, sistemas:Set, everConnected }
  let hmiSilentSince = null;
  let lastDataAt = null;

  function registerSilos(sistema, tanques) {
    tanques.forEach(t => {
      silos[sistema + ":" + t] = { sistema, tanque: t, lastSeen: null, silentSince: null, outSince: null, lastOutLog: 0 };
    });
  }

  // Cada lectura MQTT válida de un silo (percent = % de llenado ya calculado; null = lectura imposible)
  function dataReceived(sistema, tanque, percent, detalleLectura) {
    const s = silos[sistema + ":" + tanque];
    if (!s) return;
    const now = Date.now();
    s.lastSeen = now;
    lastDataAt = now;

    if (s.silentSince != null) {
      if (hmiSilentSince == null) {
        log("comunicaciones", "info", "Silo restablecido", { sistema, silo: siloName(sistema, tanque),
          detalle: "Datos nuevamente · sin señal durante " + fmtDuration(now - s.silentSince) });
      }
      s.silentSince = null;
    }
    if (hmiSilentSince != null) {
      log("comunicaciones", "info", "HMI restablecido", {
        detalle: "Datos nuevamente desde " + stamp(new Date(now)).slice(11) + " · sin datos durante " + fmtDuration(now - hmiSilentSince) });
      hmiSilentSince = null;
    }

    // Lectura fuera de rango: 0 % o ≥ 99.5 % (radar reiniciándose / distancia 0) o distancia imposible
    const out = percent == null || !(percent > 0 && percent < MAX_VALID_PCT);
    if (out) {
      if (s.outSince == null) {
        s.outSince = now;
        if (now - s.lastOutLog > 30 * 60000) {          // máximo un aviso cada 30 min por silo
          s.lastOutLog = now;
          log("proceso", "aviso", "Lectura fuera de rango", { sistema, silo: siloName(sistema, tanque),
            detalle: (detalleLectura || (percent == null ? "lectura imposible" : fmtNum(percent, 1) + " %")) +
              " · se trata como sin dato (no afecta consumo ni recepción)" });
        }
      }
    } else {
      s.outSince = null;
    }
  }

  function checkSilent() {
    const now = Date.now(), limit = SILENT_MIN * 60000;
    if (now - startedAt < limit) return;                   // margen al iniciar el servidor
    const keys = Object.keys(silos);
    if (!keys.length) return;
    const silent = k => now - (silos[k].lastSeen || startedAt) >= limit;
    const allSilent = keys.every(silent);

    if (allSilent) {
      if (hmiSilentSince == null) {
        hmiSilentSince = lastDataAt || startedAt;
        log("comunicaciones", "alarma", "HMI sin datos", {
          detalle: lastDataAt
            ? "Ningún silo publica desde " + stamp(new Date(lastDataAt)).slice(11) + " · probable corte de energía o de red en planta"
            : "No se ha recibido ningún dato desde que inició el servidor · revisar HMI, red o broker" });
      }
      return;
    }
    keys.forEach(k => {
      const s = silos[k];
      if (silent(k) && s.silentSince == null) {
        s.silentSince = s.lastSeen || startedAt;
        log("comunicaciones", "aviso", "Silo sin datos", { sistema: s.sistema, silo: siloName(s.sistema, s.tanque),
          detalle: s.lastSeen
            ? "Sin lecturas desde " + stamp(new Date(s.lastSeen)).slice(11) + " (" + SILENT_MIN + " min o más)"
            : "Sin lecturas desde que inició el servidor" });
      }
    });
  }

  function brokerConnected(sistema, url) {
    const b = brokers[url] || (brokers[url] = { connected: false, since: null, sistemas: new Set(), everConnected: false });
    b.sistemas.add(sistema);
    if (b.connected) return;
    if (b.everConnected) {
      log("comunicaciones", "info", "Broker MQTT reconectado", {
        detalle: url + " · desconectado durante " + fmtDuration(Date.now() - b.since) });
    } else {
      log("comunicaciones", "info", "Broker MQTT conectado", { detalle: url });
    }
    b.connected = true; b.everConnected = true; b.since = Date.now();
  }

  function brokerDisconnected(sistema, url, motivo) {
    const b = brokers[url] || (brokers[url] = { connected: false, since: Date.now(), sistemas: new Set(), everConnected: false });
    b.sistemas.add(sistema);
    if (!b.connected) return;
    b.connected = false; b.since = Date.now();
    log("comunicaciones", "aviso", "Broker MQTT desconectado", { detalle: url + (motivo ? " · " + motivo : "") + " · reintentando" });
  }

  // ===== PROCESO: recargas, saltos y lecturas falsas (mismas reglas que Indicadores, lib/kpi.js) =====

  const processSources = [];   // { sistema, getHistory(), silos: [{ id, toTon }] }

  function registerProcess(src) { processSources.push(src); }

  function scanProcess() {
    const now = new Date();
    const todayKey = dayKeyOf(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const y = new Date(now); y.setDate(y.getDate() - 1);
    const days = [{ key: todayKey, complete: false }];
    if (nowMin < 90) days.unshift({ key: dayKeyOf(y), complete: true });   // cierra lo que quedó abierto ayer

    processSources.forEach(src => {
      let hist;
      try { hist = src.getHistory(); } catch (e) { return; }
      src.silos.forEach(s => {
        days.forEach(d => {
          const found = [];
          const r = analyzeDay((hist[d.key] || {})[s.id], s.toTon, null, found);
          const silo = siloName(src.sistema, s.id);
          found.sort((a, b) => a.min - b.min)
            .forEach(e => recordProcessEvent(src.sistema, silo, d, e, nowMin));
          if (!d.complete) checkNoise(src, s, silo, hist, d.key, r, nowMin);
        });
      });
    });
  }

  function recordProcessEvent(sistema, silo, day, e, nowMin) {
    const ts = stampFromMin(day.key, e.min);
    const settled = day.complete || nowMin - (e.fin != null ? e.fin : e.min) >= SETTLE_MIN;
    if (e.tipo === "recarga_en_curso") {
      if (day.complete) e.tipo = "recarga";
      else {
        if (!hasSimilar("proceso", "Recarga iniciada", silo, ts, 90) && !hasSimilar("proceso", "Recarga", silo, ts, 90)) {
          log("proceso", "info", "Recarga iniciada", { sistema, silo, ts,
            detalle: "Subida gradual en curso · +" + fmtNum(e.ton, 1) + " t desde " + ts.slice(11, 16) });
        }
        return;
      }
    }
    if (e.tipo === "recarga") {
      if (hasSimilar("proceso", "Recarga", silo, ts, 60)) return;
      const dur = (e.fin - e.min) + 5;
      log("proceso", "info", "Recarga", { sistema, silo, ts,
        detalle: "+" + fmtNum(e.ton, 1) + " t en " + fmtDuration(dur * 60000) + " · " +
          fmtNum(e.tonInicio, 1) + " t → " + fmtNum(e.tonFin, 1) + " t" });
    } else if ((e.tipo === "salto" || e.tipo === "falsa") && settled) {
      // Tramo "falso" que no volvió realmente al valor previo (> 10 puntos): se informa como dos saltos
      if (e.tipo === "falsa" && Math.abs(e.despues - e.antes) > JUMP_PCT) {
        recordProcessEvent(sistema, silo, day, { tipo: "salto", min: e.min, desde: e.min - 5, antes: e.antes, despues: e.falso }, nowMin);
        recordProcessEvent(sistema, silo, day, { tipo: "salto", min: e.fin, desde: e.fin - 5, antes: e.falso, despues: e.despues }, nowMin);
        return;
      }
      const tipo = e.tipo === "salto" ? "Salto" : "Lectura falsa descartada";
      if (hasSimilar("proceso", tipo, silo, ts, 30)) return;
      // Tope diario por silo: un radar muy ruidoso no debe llenar la bitácora
      const today = events.filter(ev => ev.silo === silo && ev.ts.slice(0, 10) === day.key &&
        (ev.tipo === "Salto" || ev.tipo === "Lectura falsa descartada" || ev.tipo === "Saltos frecuentes"));
      if (today.some(ev => ev.tipo === "Saltos frecuentes")) return;
      if (today.length >= MAX_JUMPS_PER_DAY) {
        log("proceso", "aviso", "Saltos frecuentes", { sistema, silo, ts,
          detalle: "Más de " + MAX_JUMPS_PER_DAY + " saltos o lecturas falsas hoy; los siguientes no se registran uno a uno · revisar el radar (ver Ruido radar en Indicadores)" });
        return;
      }
      if (e.tipo === "falsa") {
        log("proceso", "aviso", tipo, { sistema, silo, ts,
          detalle: fmtNum(e.antes, 1) + " % → " + fmtNum(e.falso, 1) + " % → " + fmtNum(e.despues, 1) +
            " % · el nivel volvió a su valor; tramo descartado (" + fmtDuration((e.fin - e.min) * 60000) + ")" });
        return;
      }
      const gap = e.min - e.desde;
      log("proceso", "aviso", "Salto", { sistema, silo, ts,
        detalle: fmtNum(e.antes, 1) + " % → " + fmtNum(e.despues, 1) + " %" +
          (gap > 5 ? " tras " + fmtDuration(gap * 60000) + " sin datos" : " entre dos lecturas") +
          " · no se cuenta como consumo ni recepción" });
    }
  }

  // Ruido del radar elevado: ruido de hoy (desde las 3 h de datos) ≥ 3 veces el habitual de los 7 días previos
  function checkNoise(src, s, silo, hist, todayKey, r, nowMin) {
    if (!r || !r.hasData || nowMin < 180 || r.sigma < 0.15) return;
    if (events.some(ev => ev.tipo === "Ruido del radar elevado" && ev.silo === silo && ev.ts.slice(0, 10) === todayKey)) return;
    const prev = [];
    for (let i = 1; i <= 7; i++) {
      const d = parseStamp(todayKey + " 12:00:00"); d.setDate(d.getDate() - i);
      const rr = analyzeDay((hist[dayKeyOf(d)] || {})[s.id], s.toTon, null);
      if (rr.hasData) prev.push(rr.sigma);
    }
    if (prev.length < 3) return;
    prev.sort((a, b) => a - b);
    const usual = prev[Math.floor(prev.length / 2)];
    if (r.sigma < 3 * Math.max(usual, 0.03)) return;
    log("proceso", "aviso", "Ruido del radar elevado", { sistema: src.sistema, silo,
      detalle: "±" + fmtNum(r.sigma, 2) + " t hoy (habitual ±" + fmtNum(usual, 2) + " t) · revisar antena, condensación o polvo" });
  }

  // ===== OPERACIÓN: disco =====

  let diskWarnDay = null;
  function checkDisk() {
    try {
      if (!fs.statfsSync) return;
      const st = fs.statfsSync(BASE_DIR);
      const used = 100 * (1 - st.bavail / st.blocks);
      const k = dayKeyOf(new Date());
      if (used >= DISK_WARN_PCT && diskWarnDay !== k) {
        diskWarnDay = k;
        log("operacion", "aviso", "Disco casi lleno", {
          detalle: "Disco al " + fmtNum(used, 0) + " % · liberar espacio (logs/, exports/, backups/)" });
      }
    } catch (e) { /* sin información de disco */ }
  }

  // ===== SERVIDOR INICIADO / DETENIDO =====

  function version() {
    try {
      return execSync("git rev-parse --short HEAD", { cwd: BASE_DIR, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch (e) { return ""; }
  }

  function serverStarted() {
    const last = events.length ? events[events.length - 1] : null;
    const lastServer = events.slice().reverse().find(ev => ev.tipo === "Servidor iniciado" || ev.tipo === "Servidor detenido");
    const unexpected = lastServer && lastServer.tipo === "Servidor iniciado";
    const v = version();
    log("comunicaciones", unexpected ? "aviso" : "info", "Servidor iniciado", {
      detalle: "ARGOSS" + (v ? " versión " + v : "") +
        (unexpected ? " · el cierre anterior no fue registrado (corte de energía de la VM o caída del proceso)" +
          (last ? "; último evento " + last.ts : "") : "") });
  }

  let stopping = false;
  function serverStopping(signal) {
    if (stopping) return;
    stopping = true;
    log("comunicaciones", "info", "Servidor detenido", {
      detalle: signal === "SIGINT" || signal === "SIGTERM" ? "Detención ordenada (pm2 restart / stop o reinicio de la VM)" : String(signal || "") });
  }

  // ===== USUARIOS: conexión / desconexión de la página (con margen para recargas de página) =====

  const online = {};   // usuario → { sockets:Set, since, ip, timer }
  const recentLogin = {};

  const recentLogout = {};
  function userLoggedIn(usuario) { recentLogin[usuario] = Date.now(); }
  function userLoggedOut(usuario) { recentLogout[usuario] = Date.now(); }

  function socketConnected(usuario, socketId, ip) {
    const o = online[usuario] || (online[usuario] = { sockets: new Set(), since: null, ip: null, timer: null });
    if (o.timer) { clearTimeout(o.timer); o.timer = null; }
    const wasOffline = o.sockets.size === 0 && o.since == null;
    o.sockets.add(socketId);
    o.ip = ip;
    if (wasOffline) {
      o.since = Date.now();
      // Si recién inició sesión, el "Inicio de sesión" ya registra la conexión
      if (!(recentLogin[usuario] && Date.now() - recentLogin[usuario] < 2 * 60000)) {
        log("usuarios", "info", "Conectado", { usuario, ip, detalle: "Abrió ARGOSS con su sesión activa" });
      }
    }
  }

  function socketDisconnected(usuario, socketId) {
    const o = online[usuario];
    if (!o) return;
    o.sockets.delete(socketId);
    if (o.sockets.size > 0 || o.timer) return;
    o.timer = setTimeout(() => {
      o.timer = null;
      if (o.sockets.size > 0) return;
      const since = o.since;
      o.since = null;
      // Si cerró sesión, el "Cierre de sesión" ya registra la desconexión
      if (recentLogout[usuario] && Date.now() - recentLogout[usuario] < 2 * 60000) return;
      log("usuarios", "info", "Desconectado", { usuario, ip: o.ip,
        detalle: "Cerró ARGOSS o perdió la conexión · conectado durante " + fmtDuration(Date.now() - since) });
    }, 60000);
  }

  // ===== RESUMEN (tarjetas de la pestaña) =====

  function summary(admin) {
    const now = Date.now();
    const todayKey = dayKeyOf(new Date());
    const hoy = visibleFor(admin).filter(ev => ev.ts.slice(0, 10) === todayKey);
    const count = fn => hoy.filter(fn).length;

    const brokerList = Object.keys(brokers).map(u => ({ url: u, connected: brokers[u].connected }));
    const silentNow = Object.keys(silos)
      .filter(k => now - startedAt >= SILENT_MIN * 60000 && now - (silos[k].lastSeen || startedAt) >= SILENT_MIN * 60000)
      .map(k => ({ silo: siloName(silos[k].sistema, silos[k].tanque), desde: silos[k].lastSeen ? stamp(new Date(silos[k].lastSeen)) : null }));

    const out = {
      brokerOk: brokerList.length > 0 && brokerList.every(b => b.connected),
      brokers: brokerList,
      hmiSinDatos: hmiSilentSince != null,
      ultimoDato: lastDataAt ? stamp(new Date(lastDataAt)) : null,
      silosSinDatos: hmiSilentSince != null ? [] : silentNow,
      totalSilos: Object.keys(silos).length,
      eventosHoy: hoy.length,
      alarmasHoy: count(ev => ev.sev === "alarma"),
      avisosHoy: count(ev => ev.sev === "aviso"),
      recargasHoy: count(ev => ev.tipo === "Recarga"),
      // Recargas iniciadas que aún no tienen su evento "Recarga" (cierre) en el mismo silo
      recargasEnCurso: count(ev => ev.tipo === "Recarga iniciada" &&
        !hoy.some(x => x.tipo === "Recarga" && x.silo === ev.silo && x.ts >= ev.ts.slice(0, 11) + "00:00" &&
          Math.abs(parseStamp(x.ts) - parseStamp(ev.ts)) <= 90 * 60000)),
      saltosHoy: count(ev => ev.tipo === "Salto" || ev.tipo === "Lectura falsa descartada")
    };
    if (admin) {
      out.accesosHoy = count(ev => ev.tipo === "Inicio de sesión");
      out.fallidosHoy = count(ev => ev.tipo === "Login fallido");
      out.conectados = Object.keys(online).filter(u => online[u].sockets.size > 0);
    }
    return out;
  }

  // ===== SOCKET: salas según rol =====

  function attachSocket(mainIo) {
    io = mainIo;
  }

  function joinRooms(socket, usuario) {
    socket.join(isAdmin(usuario) ? "eventos-admin" : "eventos-usuarios");
  }

  // ===== RUTAS HTTP =====

  function setupRoutes(app, requireAuth, requireAdmin) {
    app.get("/eventos", requireAuth, function (req, res) {
      res.json(query(req.query, isAdmin(req.session.user)));
    });

    app.get("/eventos/export", requireAdmin, async function (req, res) {
      const rows = filteredForExport(req.query);
      const formato = req.query.formato === "csv" ? "csv" : "xlsx";
      const name = "eventos_" + dayKeyOf(new Date()).replace(/-/g, "");
      const header = ["Fecha", "Hora", "Severidad", "Categoría", "Evento", "Sistema", "Silo", "Usuario", "IP", "Detalle"];
      const catName = { usuarios: "Usuarios", comunicaciones: "Comunicaciones", proceso: "Proceso", operacion: "Operación" };
      const sevName = { info: "Info", aviso: "Aviso", alarma: "Alarma" };
      const line = ev => [ev.ts.slice(0, 10), ev.ts.slice(11), sevName[ev.sev] || ev.sev, catName[ev.cat] || ev.cat,
        ev.tipo, ev.sistema || "", ev.silo || "", ev.usuario || "", ev.ip || "", ev.detalle || ""];

      log("usuarios", "info", "Descarga de eventos", { usuario: req.session.user, ip: cleanIp(req.ip),
        detalle: formato.toUpperCase() + " · " + rows.length + " eventos" });

      try {
        if (formato === "csv") {
          const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
          const csv = "﻿" + [header].concat(rows.map(line)).map(r => r.map(esc).join(";")).join("\r\n");
          res.setHeader("Content-Type", "text/csv; charset=utf-8");
          res.setHeader("Content-Disposition", "attachment; filename=" + name + ".csv");
          return res.send(csv);
        }
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Eventos");
        ws.addRow(header);
        rows.forEach(ev => ws.addRow(line(ev)));
        ws.getRow(1).font = { bold: true };
        ws.views = [{ state: "frozen", ySplit: 1 }];
        ws.autoFilter = { from: "A1", to: "J1" };
        [12, 10, 10, 15, 26, 10, 16, 14, 16, 80].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
        const sevColor = { alarma: "FFFEE2E2", aviso: "FFFEF3C7" };
        rows.forEach((ev, i) => {
          if (sevColor[ev.sev]) ws.getRow(i + 2).getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: sevColor[ev.sev] } };
        });
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", "attachment; filename=" + name + ".xlsx");
        await wb.xlsx.write(res);
        res.end();
      } catch (e) {
        console.error("[Eventos] Error exportando:", e);
        if (!res.headersSent) res.status(500).send("No fue posible generar el archivo");
      }
    });
  }

  // ===== INICIO =====

  loadEvents();
  applyRetention();

  function start() {
    serverStarted();
    setInterval(checkSilent, 60000);
    setInterval(scanProcess, 5 * 60000);
    setTimeout(scanProcess, 90000);                    // primera revisión al minuto y medio del inicio
    setInterval(checkDisk, 60 * 60000);
    setTimeout(checkDisk, 60000);
    setInterval(applyRetention, 6 * 60 * 60000);

    ["SIGINT", "SIGTERM"].forEach(sig => process.once(sig, () => {
      serverStopping(sig);
      process.exit(0);
    }));
  }

  return {
    log, query, start, attachSocket, joinRooms, setupRoutes,
    registerSilos, dataReceived, brokerConnected, brokerDisconnected,
    registerProcess, scanProcess, checkSilent,
    userLoggedIn, userLoggedOut, socketConnected, socketDisconnected,
    describeAgent, cleanIp, fmtDuration, fmtNum
  };
}

module.exports = { createEventLog, appendEventToFile, stamp, PUBLIC_CATEGORIES };

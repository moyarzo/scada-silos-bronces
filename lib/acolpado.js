// ===== ACOLPADO DE LOS SILOS DE NITRATO =====
// Nitrato pegado a las paredes que no sale del silo: sube el nivel medido por el radar pero no es
// producto disponible. Se configura en acolpadoNitrato.json (toneladas por silo) y se descuenta de
// las toneladas de cada silo (tarjeta, totalizador, registro de turno, capacidad de planta y Excel).
// El nivel (m) y el % de llenado siguen siendo la medición física real.
//
// El archivo lo crea el sistema la primera vez y Git lo ignora: git pull nunca pisa los valores.
// Se puede editar con el sistema en marcha; los cambios se aplican solos en unos segundos y quedan
// en la bitácora (Admin).
const fs = require("fs");
const path = require("path");

const TANQUES = ["tanque1", "tanque2", "tanque3", "tanque4", "tanque5", "tanque6", "tanque7", "tanque8"];
const DEFAULTS = { tanque1: 9.6 };     // medido en pruebas (nov. 2026); el resto parte en 0

function createAcolpado(options) {
  const file = path.join(options.baseDir, "acolpadoNitrato.json");
  const eventos = options.eventos || null;
  const onChange = options.onChange || function () {};
  let values = {};

  function fmt(v) { return Number(v).toLocaleString("es-CL", { maximumFractionDigits: 2 }); }
  function nombre(t) { return "Silo " + t.replace("tanque", ""); }

  function ensureFile() {
    if (fs.existsSync(file)) return;
    const init = {};
    TANQUES.forEach(t => { init[t] = DEFAULTS[t] || 0; });
    fs.writeFileSync(file, JSON.stringify(init, null, 2) + "\n");
    console.log("[Nitrato] Creado acolpadoNitrato.json (acolpado por silo, en toneladas)");
  }

  // Lee el archivo; los valores no válidos (texto, negativos) se ignoran y quedan en 0
  function read() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.error("[Nitrato] acolpadoNitrato.json no se pudo leer:", e.message);
      if (eventos) eventos.log("operacion", "aviso", "Acolpado: archivo no válido", {
        sistema: "nitrato", detalle: "acolpadoNitrato.json no se pudo leer (" + e.message + "); se mantienen los valores anteriores" });
      return null;
    }
    const next = {}, malos = [];
    TANQUES.forEach(t => {
      const v = raw && raw[t];
      if (v == null || v === "") { next[t] = 0; return; }
      const n = Number(v);
      if (isFinite(n) && n >= 0) next[t] = n;
      else { next[t] = 0; malos.push(nombre(t) + " = " + JSON.stringify(v)); }
    });
    if (malos.length && eventos) eventos.log("operacion", "aviso", "Acolpado: valor no válido", {
      sistema: "nitrato", detalle: malos.join(", ") + " (se usa 0 t)" });
    return next;
  }

  function load(isStart) {
    const next = read();
    if (!next) return;
    const cambios = TANQUES.filter(t => (values[t] || 0) !== next[t]);
    const prev = values;
    values = next;
    if (isStart) {
      const conValor = TANQUES.filter(t => values[t] > 0).map(t => nombre(t) + " " + fmt(values[t]) + " t");
      console.log("[Nitrato] Acolpado: " + (conValor.length ? conValor.join(", ") : "sin acolpado configurado"));
      return;
    }
    if (!cambios.length) return;
    const detalle = cambios.map(t => nombre(t) + ": " + fmt(prev[t] || 0) + " → " + fmt(values[t]) + " t").join(", ");
    console.log("[Nitrato] Acolpado modificado: " + detalle);
    if (eventos) eventos.log("operacion", "info", "Acolpado modificado", { sistema: "nitrato", detalle });
    onChange(values);
  }

  ensureFile();
  load(true);
  // Revisa el archivo cada 5 s (funciona también si se edita con nano/vi o se reemplaza)
  fs.watchFile(file, { interval: 5000 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) load(false);
  });

  return {
    file,
    get(tanque) { return values[tanque] || 0; },
    all() { return Object.assign({}, values); },
    // Toneladas disponibles: medidas menos acolpado, nunca negativas
    net(tanque, tonMedidas) { return Math.max(0, tonMedidas - (values[tanque] || 0)); }
  };
}

module.exports = { createAcolpado };

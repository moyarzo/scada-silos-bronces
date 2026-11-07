// ===== PESTAÑA EVENTOS (bitácora) =====
// Datos: /eventos (filtros y paginación en el servidor, lib/eventos.js). Eventos nuevos en vivo por Socket.IO
// (evento "evento" en la conexión principal de main.js). Admin ve todas las categorías y puede descargar;
// los demás usuarios solo Comunicaciones y Proceso.

(function () {

const CAT_NAME = { usuarios: "Usuarios", comunicaciones: "Comunicaciones", proceso: "Proceso", operacion: "Operación" };
const SEV_NAME = { info: "Info", aviso: "Aviso", alarma: "Alarma" };
const PAGE_SIZE = 50;

let cat = "";
let shown = PAGE_SIZE;
let isAdmin = false;
let lastData = null;
let reloadTimer = null;
const fresh = new Set();          // ids de eventos recién llegados (destello)

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const dayKey = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = v => Number(v || 0).toLocaleString("es-CL");

function dayTitle(k) {
  const now = new Date();
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (k === dayKey(now)) return "Hoy";
  if (k === dayKey(y)) return "Ayer";
  const d = new Date(k + "T12:00:00");
  const t = d.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ===== FILTROS =====

function filters() {
  return {
    desde: $("evFrom").value, hasta: $("evTo").value, sev: $("evSev").value,
    silo: $("evSilo").value, usuario: isAdmin ? $("evUser").value : "", q: $("evSearch").value.trim(), cat
  };
}

function qs(extra) {
  const f = Object.assign(filters(), extra || {});
  return Object.keys(f).filter(k => f[k] !== "" && f[k] != null)
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(f[k])).join("&");
}

// ===== CARGA =====

function load() {
  return fetch("/eventos?" + qs({ limit: shown, offset: 0 }))
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data) return;
      lastData = data;
      isAdmin = data.categorias.indexOf("usuarios") >= 0;
      render(data);
    })
    .catch(() => {});
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 1500);
}

// ===== RENDER =====

function renderTiles(r) {
  const tiles = [];

  // Comunicaciones ahora
  if (r.hmiSinDatos) {
    tiles.push({ cls: "alarma", label: "Comunicaciones ahora", value: "HMI sin datos", small: true });
  } else if (!r.brokerOk) {
    tiles.push({ cls: "alarma", label: "Comunicaciones ahora", value: "Broker desconectado", small: true });
  } else {
    tiles.push({ cls: "ok", label: "Comunicaciones ahora", value: "HMI y broker OK", small: true });
  }

  const sd = (r.silosSinDatos || []).length;
  tiles.push({ cls: r.hmiSinDatos || sd ? "aviso" : "ok", label: "Silos sin datos ahora", value: r.hmiSinDatos ? "Todos" : sd });

  tiles.push({ cls: r.alarmasHoy ? "alarma" : "ok", label: "Alarmas hoy", value: num(r.alarmasHoy) });

  tiles.push({ cls: "", label: "Proceso hoy", small: true,
    value: num(r.recargasHoy) + (r.recargasHoy === 1 ? " recarga" : " recargas") });

  if (isAdmin) tiles.push({ cls: "", label: "Accesos hoy", value: num(r.accesosHoy) });

  $("evTiles").innerHTML = tiles.map(t => `
    <div class="ev-tile ${t.cls}">
      <div class="ev-tile-label">${t.label}</div>
      <div class="ev-tile-value${t.small ? " small" : ""}">${esc(t.value)}</div>
    </div>`).join("");
}

function renderChips(data) {
  const list = [""].concat(data.categorias);
  $("evChips").innerHTML = list.map(id =>
    `<button class="ev-chip ${cat === id ? "active" : ""}" data-cat="${id}">${id ? CAT_NAME[id] : "Todos"}` +
    `<span class="ev-count">${num(data.counts[id] || 0)}</span></button>`).join("");
  $("evChips").querySelectorAll(".ev-chip").forEach(b => {
    b.onclick = () => { cat = b.dataset.cat; shown = PAGE_SIZE; load(); };
  });
}

function fillSelect(el, items, allText) {
  const current = el.value;
  el.innerHTML = `<option value="">${allText}</option>` + items.map(v => `<option>${esc(v)}</option>`).join("");
  if (items.indexOf(current) >= 0) el.value = current;
}

function renderTable(data) {
  const cols = isAdmin ? 7 : 6;
  let html = `<tr><th>Hora</th><th>Severidad</th><th>Categoría</th><th>Evento</th><th>Silo</th>` +
    `${isAdmin ? "<th>Usuario</th>" : ""}<th>Detalle</th></tr>`;
  let lastDay = null;
  data.eventos.forEach(e => {
    const k = e.ts.slice(0, 10);
    if (k !== lastDay) { html += `<tr class="ev-day"><td colspan="${cols}">${dayTitle(k)}</td></tr>`; lastDay = k; }
    html += `<tr${fresh.has(e.id) ? ' class="ev-new"' : ""}>
      <td class="ev-time">${e.ts.slice(11, 19)}</td>
      <td><span class="ev-sev ${e.sev}">${SEV_NAME[e.sev] || e.sev}</span></td>
      <td class="ev-cat">${CAT_NAME[e.cat] || e.cat}</td>
      <td class="ev-type">${esc(e.tipo)}</td>
      <td class="ev-silo">${esc(e.silo || "—")}</td>
      ${isAdmin ? `<td>${esc(e.usuario || "—")}</td>` : ""}
      <td class="ev-detail">${esc(e.detalle)}</td></tr>`;
  });
  if (!data.eventos.length) {
    html += `<tr><td colspan="${cols}" class="ev-empty">Sin eventos para los filtros elegidos</td></tr>`;
  }
  $("evTable").innerHTML = html;
  fresh.clear();

  $("evFooter").innerHTML =
    `<span>Mostrando ${num(data.eventos.length)} de ${num(data.total)} eventos · se conservan ${Math.round(data.retencionDias / 30)} meses</span>` +
    (data.total > data.eventos.length ? `<button class="ev-more" id="evMore">Mostrar más</button>` : "");
  const more = $("evMore");
  if (more) more.onclick = () => { shown += PAGE_SIZE; load(); };
}

function render(data) {
  renderTiles(data.resumen);
  renderChips(data);
  fillSelect($("evSilo"), data.silos, "Todos los silos");
  if (isAdmin) fillSelect($("evUser"), data.usuarios, "Todos los usuarios");
  renderTable(data);
}

// ===== EVENTOS DE LOS CONTROLES =====

let searchTimer = null;
["evFrom", "evTo", "evSev", "evSilo", "evUser"].forEach(id => {
  $(id).addEventListener("change", () => { shown = PAGE_SIZE; load(); });
});
$("evSearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { shown = PAGE_SIZE; load(); }, 300);
});

function download(formato) {
  window.location.href = "/eventos/export?" + qs({ formato });
}
$("evExcel").addEventListener("click", () => download("xlsx"));
$("evCsv").addEventListener("click", () => download("csv"));

// ===== EN VIVO =====

if (typeof socket !== "undefined") {
  socket.on("evento", ev => {
    if (!ev) return;
    fresh.add(ev.id);
    if (document.body.dataset.page === "eventos") scheduleReload();
  });
}

// El resumen ("hace 12 s", silos sin datos) se refresca cada 30 s mientras la pestaña está visible
let tick = null;
function onPage(page) {
  if (page === "eventos") {
    load();
    if (!tick) tick = setInterval(load, 30000);
  } else if (tick) {
    clearInterval(tick);
    tick = null;
  }
}

document.addEventListener("scada:pagechange", e => onPage(e.detail && e.detail.page));
if (document.body.dataset.page === "eventos") onPage("eventos");

})();

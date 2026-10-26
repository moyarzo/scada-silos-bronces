// ===== FRONTEND SILOS NITRATO =====
// Encapsulado en una función para convivir con el otro sistema en la misma página.
// Silos → pestaña "Nitrato" (#gridNitrato) · Gráficos totalizadores → pestaña "Totalizadores" (#topPanelNitrato)

(function () {

const socket = io("/nitrato");

// ===== CONSTANTES SILO NITRATO =====
// Tolva inferior: pirámide truncada cuadrada
//   base inferior 2.78m, base superior 3.48m, altura 0.78m
// Cilindro superior: sección cuadrada 3.48x3.48m, altura 5.95m
// Volumen total: 79.73 m³

const N_TOLVA_HEIGHT = 0.78;
const N_CYL_HEIGHT   = 5.95;
const N_MAX_HEIGHT   = N_TOLVA_HEIGHT + N_CYL_HEIGHT;  // 6.73 m
const N_A_INF        = 2.78;   // lado base inferior tolva
const N_A_SUP        = 3.48;   // lado base superior tolva = lado cilindro
const N_DA           = N_A_SUP - N_A_INF;              // 0.70
const N_B            = N_DA / N_TOLVA_HEIGHT;           // pendiente interpolación
const N_V_TOLVA      = 7.6734; // m³ (pirámide truncada completa)
const N_V_TOTAL      = 79.730; // m³

const PRODUCT_ORDER = ["Nitrato"];

const PRODUCTS = {
  "Nitrato": { density: 750, color: "#ca8a04" }
};

// ===== ESTADO GLOBAL =====
let mode = "real";
let turnData        = {};
let historyTurnData = {};
let charts          = {};
let siloMiniCharts  = {};
let selectedHistoryDate   = "";
let availableHistoryDates = [];
let siloTrendReal   = {};

let lastMqttUpdate    = "--:--:--";
let mqttSignalOk      = false;
let lastMqttHeartbeat = 0;

let historyReal = { "Nitrato": [] };
let historyDemo = { "Nitrato": [] };
let historyTotals = null;

const realTanks = {};
const demoTanks = {};

for (let i = 1; i <= 8; i++) {
  const id = "tanque" + i;
  realTanks[id] = { levelMeters: 0, volume: 0, percent: 0, product: "Nitrato" };
  demoTanks[id] = { levelMeters: 0, volume: 0, percent: 0, product: "Nitrato" };
}

// ===== CÁLCULO DE VOLUMEN =====

function calculateVolume(level) {
  const s = Math.max(0, Math.min(N_MAX_HEIGHT, level));
  if (s <= N_TOLVA_HEIGHT) {
    // Integral de (A_INF + B·y)² dy de 0 a s
    const A = N_A_INF, B = N_B;
    return (Math.pow(A + B * s, 3) - Math.pow(A, 3)) / (3 * B);
  }
  return N_V_TOLVA + N_A_SUP * N_A_SUP * (s - N_TOLVA_HEIGHT);
}

function calculateMassTon(volume, product) {
  return (volume * PRODUCTS[product].density) / 1000;
}

// ===== ETIQUETAS TEMPORALES =====

function getRounded5MinLabel() {
  const now = new Date();
  const r   = Math.floor(now.getMinutes() / 5) * 5;
  return `${String(now.getHours()).padStart(2,"0")}:${String(r).padStart(2,"0")}`;
}

function getFixedDayLabels() {
  const labels = [];
  for (let h = 7; h <= 19; h++) {
    for (let m = 0; m < 60; m += 5) {
      if (h === 19 && m > 0) break;
      labels.push(`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`);
    }
  }
  return labels;
}
const FIXED_DAY_LABELS = getFixedDayLabels();

function buildFixedSeries(historyArray) {
  const map = {};
  (historyArray || []).forEach(item => { map[item.time] = item.value; });
  return FIXED_DAY_LABELS.map(label =>
    Object.prototype.hasOwnProperty.call(map, label) ? map[label] : null
  );
}

// ===== HELPERS =====

function getViewTanks()   { return mode === "real" ? realTanks : demoTanks; }
function getViewHistory() { return mode === "real" ? historyReal : historyDemo; }

function getActiveProducts() {
  const active = new Set();
  Object.keys(getViewTanks()).forEach(k => active.add(getViewTanks()[k].product));
  return PRODUCT_ORDER.filter(p => active.has(p));
}

function getTodayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
}

function isSelectedDateToday() {
  return selectedHistoryDate === getTodayKey() || selectedHistoryDate === "";
}

// ===== MQTT STATUS =====

function updateMqttStatus() {
  // Estado de señal único para Matriz y Nitrato (mismo HMI / broker): ver main.js
  if (window.scadaMqttStatus) {
    window.scadaMqttStatus.update("nitrato", mqttSignalOk, lastMqttUpdate, lastMqttHeartbeat);
  }
}

// ===== GAUGE =====

function createGauge(percent, color) {
  const radius        = 55;
  const circumference = Math.PI * radius;
  const progress      = (percent / 100) * circumference;
  return `
    <svg width="150" height="100" viewBox="0 0 150 100" preserveAspectRatio="xMidYMid meet">
      <path d="M20 75 A55 55 0 0 1 130 75" stroke="#e5e7eb" stroke-width="12" fill="none"></path>
      <path d="M20 75 A55 55 0 0 1 130 75" stroke="${color}" stroke-width="12" fill="none"
        stroke-dasharray="${circumference}" stroke-dashoffset="${circumference - progress}"
        style="transition:stroke-dashoffset 0.6s ease;"></path>
      <text x="18" y="92" font-size="12">0%</text>
      <text x="75" y="62" font-size="12" text-anchor="middle">50%</text>
      <text x="112" y="92" font-size="12">100%</text>
    </svg>
    <div class="gauge-value" style="color:${color}">${percent.toFixed(1)}%</div>`;
}

// ===== DATE SELECTOR =====

function renderDateSelector() {
  const select = document.getElementById("chartDateSelect");
  if (!select) return;
  if (!availableHistoryDates.length) { select.innerHTML = ""; return; }

  const todayKey = getTodayKey();
  select.innerHTML = availableHistoryDates.map(dateKey => {
    const label = dateKey === todayKey ? dateKey + " (Hoy)" : dateKey;
    return `<option value="${dateKey}" ${dateKey === selectedHistoryDate ? "selected" : ""}>${label}</option>`;
  }).join("");

  // Selector de fecha compartido con el otro sistema: se agrega un listener propio
  if (!select.dataset.boundNitrato) {
    select.dataset.boundNitrato = "1";
    select.addEventListener("change", function () {
      selectedHistoryDate = select.value;
      socket.emit("getHistoryData",   { date: selectedHistoryDate });
      socket.emit("getSiloTrendData", { date: selectedHistoryDate });
      socket.emit("getTurnData",      { date: selectedHistoryDate });
    });
  }
}

// ===== TOP PANEL =====

function renderTopPanel() {
  const topPanel = document.getElementById("topPanelNitrato");
  if (!topPanel) return;
  const activeProducts = getActiveProducts();
  topPanel.style.gridTemplateColumns = `repeat(${activeProducts.length || 1}, minmax(0, 1fr))`;
  topPanel.innerHTML = activeProducts.map(product => {
    const safeId = product.replace(/[^a-zA-Z0-9]/g, "");
    return `
      <div class="panel-card">
        <div id="summary-${safeId}" class="summary-card"></div>
        <div class="chart-wrapper"><canvas id="chart-${safeId}"></canvas></div>
      </div>`;
  }).join("");
}

// ===== TREND MARKER PLUGIN =====

const trendMarkerPlugin = {
  id: "trendMarkerPlugin",
  afterDatasetsDraw(chart) {
    const ctx     = chart.ctx;
    const dataset = chart.data.datasets[0];
    const meta    = chart.getDatasetMeta(0);
    if (!meta || !meta.data || meta.data.length < 2) return;
    ctx.save();
    ctx.font = "bold 12px Consolas";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 1; i < dataset.data.length; i++) {
      const prev  = dataset.data[i - 1];
      const curr  = dataset.data[i];
      const point = meta.data[i];
      if (prev == null || curr == null || !point) continue;
      let symbol = "", color = "";
      if      (curr > prev) { symbol = "▲"; color = "#16a34a"; }
      else if (curr < prev) { symbol = "▼"; color = "#dc2626"; }
      else continue;
      const x = point.x, y = point.y - 14;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fillStyle = "#f8fafc"; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = color; ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(symbol, x, y + 0.5);
    }
    ctx.restore();
  }
};

// ===== CHARTS =====

function initCharts() {
  Object.keys(charts).forEach(k => charts[k].destroy());
  charts = {};

  getActiveProducts().forEach(product => {
    const safeId = product.replace(/[^a-zA-Z0-9]/g, "");
    const canvas  = document.getElementById(`chart-${safeId}`);
    if (!canvas) return;

    charts[product] = new Chart(canvas.getContext("2d"), {
      type: "line",
      plugins: [trendMarkerPlugin],
      data: {
        labels: FIXED_DAY_LABELS,
        datasets: [{
          label: product, data: [],
          fill: true,
          backgroundColor: PRODUCTS[product].color + "22",
          tension: 0.15, pointRadius: 0, pointHoverRadius: 4,
          borderWidth: 3, borderColor: "#111827", spanGaps: false
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          zoom: {
            pan:  { enabled: true, mode: "x" },
            zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" }
          },
          tooltip: {
            callbacks: {
              label: ctx => ctx.parsed.y == null ? "Sin dato" : `${ctx.parsed.y.toFixed(2)} ton`
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: "Hora" },
            min: 0, max: FIXED_DAY_LABELS.length - 1,
            ticks: { autoSkip: true, maxTicksLimit: window.innerWidth < 768 ? 7 : 13 },
            grid:  { display: true, color: "#dbe2ea", lineWidth: 1 }
          },
          y: {
            min: 0, max: 500,
            title: { display: true, text: "Ton" },
            ticks: { stepSize: 50 },
            grid:  { display: true, color: "#e5e7eb", lineWidth: 1 }
          }
        }
      }
    });
  });
}

function updateCharts() {
  const src = getViewHistory();
  Object.keys(charts).forEach(product => {
    charts[product].data.labels           = FIXED_DAY_LABELS;
    charts[product].data.datasets[0].data = buildFixedSeries(src[product] || []);
    charts[product].update();
  });
}

// ===== MINI CHARTS =====

function destroyMiniCharts() {
  Object.keys(siloMiniCharts).forEach(id => {
    if (siloMiniCharts[id]) siloMiniCharts[id].destroy();
  });
  siloMiniCharts = {};
}

function updateMiniSiloCharts() {
  if (mode !== "real") { destroyMiniCharts(); return; }

  Object.keys(realTanks).forEach(id => {
    const canvas = document.getElementById("mini-nitrato-" + id);
    if (!canvas) return;
    const data = buildFixedSeries(siloTrendReal[id] || []);

    siloMiniCharts[id] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: FIXED_DAY_LABELS,
        datasets: [{
          data, borderColor: "#111827", borderWidth: 2, pointRadius: 0,
          fill: true, backgroundColor: "rgba(17,24,39,0.08)", tension: 0.25, spanGaps: false
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false },
          tooltip: { enabled: true, callbacks: {
            label: ctx => ctx.parsed.y == null ? "Sin dato" : ctx.parsed.y.toFixed(1) + "%"
          }}
        },
        scales: {
          x: {
            display: true, min: 0, max: FIXED_DAY_LABELS.length - 1,
            ticks: { autoSkip: false, font: { size: 9 },
              callback(value) {
                const lbl = this.getLabelForValue(value);
                return (lbl === "07:00" || lbl === "12:00" || lbl === "19:00") ? lbl : "";
              }
            },
            grid: { display: true,
              color(ctx) {
                const l = ctx.tick && ctx.tick.label;
                return (l === "07:00" || l === "12:00" || l === "19:00") ? "#cbd5e1" : "#edf2f7";
              },
              lineWidth(ctx) {
                const l = ctx.tick && ctx.tick.label;
                return (l === "07:00" || l === "12:00" || l === "19:00") ? 1.2 : 0.5;
              }
            }
          },
          y: {
            display: true, min: 0, max: 100,
            ticks: { stepSize: 50, font: { size: 9 }, callback: v => v + "%" },
            grid:  { display: true, color: "#e5e7eb", lineWidth: 1 }
          }
        }
      }
    });
  });
}

// ===== SUMMARY =====

function computeHistoryTotals(historyForDate) {
  const totals = {};
  PRODUCT_ORDER.forEach(p => {
    const arr   = historyForDate[p] || [];
    totals[p]   = arr.length > 0 ? (Number(arr[arr.length - 1].value) || 0) : 0;
  });
  return totals;
}

function computeLiveTotals() {
  const totals = { "Nitrato": 0 };
  Object.keys(getViewTanks()).forEach(key => {
    const t = getViewTanks()[key];
    totals[t.product] = (totals[t.product] || 0) + calculateMassTon(t.volume, t.product);
  });
  return totals;
}

function renderSummary() {
  const isToday = isSelectedDateToday();
  let totals;
  if (mode === "demo") totals = computeLiveTotals();
  else if (isToday)   totals = computeLiveTotals();
  else                totals = historyTotals || computeHistoryTotals(getViewHistory());

  const activeTurn = (mode === "real" && !isToday) ? historyTurnData : turnData;
  const td         = activeTurn.data ? activeTurn.data : activeTurn;
  const start      = td.start || {};
  const end        = td.end   || {};
  const dateLabel  = isToday ? "Hoy" : (selectedHistoryDate || getTodayKey());

  Object.keys(charts).forEach(product => {
    const safeId = product.replace(/[^a-zA-Z0-9]/g, "");
    const el     = document.getElementById(`summary-${safeId}`);
    if (!el) return;

    if (mode === "real") {
      el.innerHTML = `
        <div style="background:${PRODUCTS[product].color};padding:8px;border-radius:8px;color:#fff;">
          <strong>${product}</strong> &mdash; <span style="font-size:.85em;opacity:.9">${dateLabel}</span><br>
          <strong>Totalizador:</strong> ${(totals[product] || 0).toFixed(1)} ton<br>
          <strong>Registro turno:</strong>
          07h: ${start[product] != null ? Number(start[product]).toFixed(1) : "-"} ton |
          19h: ${end[product]   != null ? Number(end[product]).toFixed(1)   : "-"} ton
        </div>`;
    } else {
      el.innerHTML = `
        <div style="background:${PRODUCTS[product].color};padding:8px;border-radius:8px;color:#fff;">
          <strong>${product}</strong><br>
          <strong>Totalizador:</strong> ${(totals[product] || 0).toFixed(1)} ton<br>
          <strong>Modo:</strong> Demo
        </div>`;
    }
  });
}

// ===== DEMO HISTORY =====

function updateDemoHistory() {
  const label  = getRounded5MinLabel();
  const totals = computeLiveTotals();
  PRODUCT_ORDER.forEach(product => {
    const arr       = historyDemo[product] || [];
    const lastEntry = arr[arr.length - 1];
    if (!lastEntry)                    arr.push({ time: label, value: totals[product] });
    else if (lastEntry.time !== label) arr.push({ time: label, value: totals[product] });
    else                               lastEntry.value = totals[product];
    historyDemo[product] = arr;
  });
}

// ===== EXPORT =====

function exportData()  { window.location.href = "/nitrato/export-data"; }
function exportTrend() { window.location.href = "/nitrato/export-daily-summary"; }

// ===== RENDER PRINCIPAL =====

function render() {
  const viewTanks = getViewTanks();
  const grid      = document.getElementById("gridNitrato");
  if (!grid) return;

  destroyMiniCharts();
  grid.innerHTML = "";

  Object.keys(viewTanks).forEach(id => {
    const t       = viewTanks[id];
    const product = PRODUCTS[t.product];
    const percent = Math.max(0, Math.min(100, t.percent || 0));

    // Representación visual: tolva trapezoidal → sección cónica inferior
    let coneFill = 0, rectFill = 0;
    if (t.levelMeters <= N_TOLVA_HEIGHT) {
      coneFill = (t.levelMeters / N_TOLVA_HEIGHT) * 60;
      rectFill = 0;
    } else {
      coneFill = 60;
      rectFill = ((t.levelMeters - N_TOLVA_HEIGHT) / N_CYL_HEIGHT) * 100;
    }

    const div = document.createElement("div");
    let className = "tank";
    if (percent >= 90) className += " alert-high";
    else if (percent >= 85) className += " warning";
    div.className = className;

    div.innerHTML = `
      <h3>Silo ${id.replace("tanque", "")}</h3>
      <div class="tank-main">
        <div class="tank-left-panel">
          <div class="tank-left-data">
            <div>${t.approx ? "≈ " : ""}${t.levelMeters.toFixed(2)} m</div>
            <div>${t.volume.toFixed(2)} m³</div>
            <div class="tank-mass">${calculateMassTon(t.volume, t.product).toFixed(2)} ton</div>
            <div>${product.density} kg/m³</div>
          </div>
          <div class="gauge-container compact-gauge">${createGauge(percent, product.color)}</div>
        </div>
        <div class="tank-wrapper">
          <div class="scale">
            <div>6.73</div><div>5</div><div>4</div><div>3</div><div>2</div><div>1</div><div>0</div>
          </div>
          <div class="tank-container">
            <div class="tank-rect">
              <div class="liquid-rect" style="height:${rectFill}%;background:${product.color}"></div>
            </div>
            <div class="tank-cone">
              <div class="liquid-cone" style="border-top:${coneFill}px solid ${product.color}"></div>
            </div>
          </div>
          <div class="mini-chart-container"><canvas id="mini-nitrato-${id}"></canvas></div>
        </div>
      </div>
      <select class="product-select" data-id="${id}" disabled>
        <option value="Nitrato" selected>Nitrato</option>
      </select>`;

    grid.appendChild(div);
  });

  const chartKey = `${mode}|${getActiveProducts().join("|")}`;
  if (render.lastChartKey !== chartKey) {
    render.lastChartKey = chartKey;
    renderTopPanel();
    initCharts();
  }

  updateCharts();
  renderSummary();
  updateMqttStatus();
  updateMiniSiloCharts();
}

// ===== SOCKET EVENTS =====

socket.on("nivel", data => {
  if (!data) return;
  if (data.serverTime) lastMqttUpdate = data.serverTime;
  mqttSignalOk      = true;
  lastMqttHeartbeat = Date.now();
  updateMqttStatus();
});

socket.on("siloState", backendState => {
  Object.keys(backendState || {}).forEach(tanque => {
    if (!realTanks[tanque]) return;
    realTanks[tanque] = {
      levelMeters: backendState[tanque].levelMeters || 0,
      volume:      backendState[tanque].volume      || 0,
      percent:     backendState[tanque].percent     || 0,
      approx:      !!backendState[tanque].approx,
      product:     "Nitrato"
    };
  });
  if (mode === "real") render();
});

socket.on("turnData", data => {
  if (!data) return;
  const isHistorical = data.date && data.date !== getTodayKey();
  if (isHistorical) historyTurnData = data;
  else              turnData        = data.data ? data.data : data;
  if (mode === "real") renderSummary();
});

socket.on("historyDates", dates => {
  availableHistoryDates = dates || [];
  if (!selectedHistoryDate && availableHistoryDates.length > 0)
    selectedHistoryDate = availableHistoryDates[availableHistoryDates.length - 1];
  renderDateSelector();
  socket.emit("getHistoryData",   { date: selectedHistoryDate });
  socket.emit("getSiloTrendData", { date: selectedHistoryDate });
  socket.emit("getTurnData",      { date: selectedHistoryDate });
});

socket.on("historyData", payload => {
  if (payload && payload.date && selectedHistoryDate && payload.date !== selectedHistoryDate) return;
  const backendHistory = payload && payload.history ? payload.history : payload;
  historyReal["Nitrato"] = backendHistory["Nitrato"] || [];
  historyTotals = computeHistoryTotals(historyReal);
  if (mode === "real") render();
});

socket.on("siloTrendData", payload => {
  if (payload && payload.date && selectedHistoryDate && payload.date !== selectedHistoryDate) return;
  siloTrendReal = payload && payload.history ? payload.history : {};
  if (mode === "real") render();
});

// ===== REQUEST REAL DATA =====

function requestRealData() {
  socket.emit("getTurnData",      { date: getTodayKey() });
  socket.emit("getSiloConfig");
  socket.emit("getHistoryDates");
  socket.emit("getHistoryData",   { date: selectedHistoryDate });
  socket.emit("getSiloTrendData", { date: selectedHistoryDate });
  socket.emit("getSiloState");
}

// ===== DEMO INTERVAL =====

setInterval(() => {
  Object.keys(demoTanks).forEach(id => {
    const current = demoTanks[id].levelMeters || (N_MAX_HEIGHT / 2);
    const next    = Math.max(0, Math.min(N_MAX_HEIGHT, current + (Math.random() - 0.5) * 0.3));
    const volume  = calculateVolume(next);
    const percent = (volume / N_V_TOTAL) * 100;
    demoTanks[id] = { levelMeters: next, volume, percent, product: "Nitrato" };
  });
  updateDemoHistory();
  if (mode === "demo") render();
}, 2000);

// ===== MQTT WATCHDOG =====

setInterval(() => {
  if (!lastMqttHeartbeat || Date.now() - lastMqttHeartbeat > 300000) {
    mqttSignalOk = false;
    updateMqttStatus();
  }
}, 1000);

// ===== RESIZE (ignorar cambios solo de altura — móvil) =====

let lastKnownWidth = window.innerWidth;
window.addEventListener("resize", () => {
  const w = window.innerWidth;
  if (w === lastKnownWidth) return;
  lastKnownWidth = w;
  renderTopPanel();
  initCharts();
  updateCharts();
  destroyMiniCharts();
  updateMiniSiloCharts();
});

// ===== EVENT LISTENERS =====

document.querySelectorAll('input[name="mode"]').forEach(radio => {
  radio.addEventListener("change", e => {
    mode = e.target.value;
    if (mode === "real") requestRealData();
    render();
  });
});

document.getElementById("exportBtnNitrato").addEventListener("click", exportData);
document.getElementById("exportTrendBtnNitrato").addEventListener("click", exportTrend);

// ===== INIT =====

requestRealData();
renderDateSelector();
renderTopPanel();
initCharts();
render();
updateMqttStatus();

// ===== CAMBIO DE PESTAÑA =====
// Al mostrar una pestaña se redibuja para que Chart.js tome el tamaño real del contenedor.

document.addEventListener("scada:pagechange", function () {
  render.lastChartKey = null;
  render();
});

})();

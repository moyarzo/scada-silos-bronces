// ===== FRONTEND SILOS MATRIZ =====
// Encapsulado en una función para convivir con el otro sistema en la misma página.
// Silos → pestaña "Matriz" (#gridMatriz) · Gráficos totalizadores → pestaña "Totalizadores" (#topPanelMatriz)

(function () {

const socket = io("/matriz");

const CONE_HEIGHT = 1.67;
const CYL_HEIGHT = 4.25;
const MAX_HEIGHT = CONE_HEIGHT + CYL_HEIGHT;
const V_TOTAL = 46.168;

const PRODUCT_ORDER = ["DL-5", "VE-03", "ASE"];
const ratio = (1 / 3) * (CONE_HEIGHT / CYL_HEIGHT);
const V_CYL = V_TOTAL / (1 + ratio);
const V_CONE = V_TOTAL - V_CYL;

const PRODUCTS = {
  "DL-5": { density: 1300, color: "#2563eb" },
  "VE-03": { density: 1370, color: "#16a34a" },
  "ASE": { density: 800, color: "#ea580c" }
};

let mode = "real";
let turnData = {};           // Turno del día actual (en vivo)
let historyTurnData = {};    // Turno de la fecha seleccionada (histórico)
let charts = {};
let siloMiniCharts = {};
let selectedHistoryDate = "";
let availableHistoryDates = [];
let siloTrendReal = {};
let demoProductsInitialized = false;

let lastMqttUpdate = "--:--:--";
let mqttSignalOk = false;
let lastMqttHeartbeat = 0;

let historyReal = { "DL-5": [], "VE-03": [], "ASE": [] };
let historyDemo = { "DL-5": [], "VE-03": [], "ASE": [] };

// Totales calculados a partir del historial de la fecha seleccionada
// (máximo valor del día = estimación del stock en ese día)
let historyTotals = null;

const realTanks = {};
const demoTanks = {};

for (let i = 1; i <= 8; i++) {
  const id = "tanque" + i;
  const defaultProduct = i === 6 ? "ASE" : "DL-5";

  realTanks[id] = { levelMeters: 0, volume: 0, percent: 0, product: defaultProduct };
  demoTanks[id] = { levelMeters: 0, volume: 0, percent: 0, product: defaultProduct };
}

// ===== CÁLCULOS =====

function calculateVolume(level) {
  const safeLevel = Math.max(0, Math.min(MAX_HEIGHT, level));
  if (safeLevel <= CONE_HEIGHT) {
    return V_CONE * Math.pow(safeLevel / CONE_HEIGHT, 3);
  }
  return V_CONE + V_CYL * ((safeLevel - CONE_HEIGHT) / CYL_HEIGHT);
}

function calculateMassTon(volume, product) {
  return (volume * PRODUCTS[product].density) / 1000;
}

function getRounded5MinLabel() {
  const now = new Date();
  const rounded = Math.floor(now.getMinutes() / 5) * 5;
  return `${String(now.getHours()).padStart(2, "0")}:${String(rounded).padStart(2, "0")}`;
}

function getFixedDayLabels() {
  const labels = [];
  for (let h = 7; h <= 19; h++) {
    for (let m = 0; m < 60; m += 5) {
      if (h === 19 && m > 0) break;
      labels.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return labels;
}

const FIXED_DAY_LABELS = getFixedDayLabels();

function buildFixedSeries(historyArray) {
  const map = {};
  (historyArray || []).forEach(function (item) {
    map[item.time] = item.value;
  });

  return FIXED_DAY_LABELS.map(function (label) {
    return Object.prototype.hasOwnProperty.call(map, label) ? map[label] : null;
  });
}

// ===== HELPERS =====

function getTodayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isSelectedDateToday() {
  return selectedHistoryDate === getTodayKey() || selectedHistoryDate === "";
}

function getViewTanks() {
  return mode === "real" ? realTanks : demoTanks;
}

function getViewHistory() {
  return mode === "real" ? historyReal : historyDemo;
}

function getActiveProducts() {
  const active = new Set();
  const source = getViewTanks();

  Object.keys(source).forEach(function (key) {
    active.add(source[key].product);
  });

  return PRODUCT_ORDER.filter(function (product) {
    return active.has(product);
  });
}

function setProductForCurrentMode(tanque, product) {
  if (!PRODUCTS[product]) return;

  if (mode === "real") {
    if (realTanks[tanque]) realTanks[tanque].product = product;
  } else {
    if (demoTanks[tanque]) demoTanks[tanque].product = product;
  }
}

// ===== MQTT STATUS =====

function updateMqttStatus() {
  // Estado de señal único para Matriz y Nitrato (mismo HMI / broker): ver main.js
  if (window.scadaMqttStatus) {
    window.scadaMqttStatus.update("matriz", mqttSignalOk, lastMqttUpdate, lastMqttHeartbeat);
  }
}

// ===== GAUGE =====

function createGauge(percent, color) {
  const radius = 55;
  const circumference = Math.PI * radius;
  const progress = (percent / 100) * circumference;

  return `
    <svg width="150" height="100" viewBox="0 0 150 100" preserveAspectRatio="xMidYMid meet">
      <path d="M20 75 A55 55 0 0 1 130 75"
        stroke="#e5e7eb"
        stroke-width="12"
        fill="none"></path>

      <path d="M20 75 A55 55 0 0 1 130 75"
        stroke="${color}"
        stroke-width="12"
        fill="none"
        stroke-dasharray="${circumference}"
        stroke-dashoffset="${circumference - progress}"
        style="transition: stroke-dashoffset 0.6s ease;"></path>

      <text x="18" y="92" font-size="12">0%</text>
      <text x="75" y="62" font-size="12" text-anchor="middle">50%</text>
      <text x="112" y="92" font-size="12">100%</text>
    </svg>
    <div class="gauge-value" style="color:${color}">${percent.toFixed(1)}%</div>
  `;
}

// ===== DATE SELECTOR =====

function renderDateSelector() {
  const select = document.getElementById("chartDateSelect");
  if (!select) return;

  if (!availableHistoryDates.length) {
    select.innerHTML = "";
    return;
  }

  const todayKey = getTodayKey();

  select.innerHTML = availableHistoryDates.map(function (dateKey) {
    const label = dateKey === todayKey ? dateKey + " (Hoy)" : dateKey;
    return `<option value="${dateKey}" ${dateKey === selectedHistoryDate ? "selected" : ""}>${label}</option>`;
  }).join("");

  // Selector de fecha compartido con el otro sistema: se agrega un listener propio
  if (!select.dataset.boundMatriz) {
    select.dataset.boundMatriz = "1";
    select.addEventListener("change", function () {
      selectedHistoryDate = select.value;
      socket.emit("getHistoryData", { date: selectedHistoryDate });
      socket.emit("getSiloTrendData", { date: selectedHistoryDate });
      // Solicitar datos de turno para la fecha seleccionada
      socket.emit("getTurnData", { date: selectedHistoryDate });
    });
  }
}

// ===== TOP PANEL =====

function renderTopPanel() {
  const topPanel = document.getElementById("topPanelMatriz");
  if (!topPanel) return;

  const activeProducts = getActiveProducts();
  topPanel.style.gridTemplateColumns = `repeat(${activeProducts.length || 1}, minmax(0, 1fr))`;

  topPanel.innerHTML = activeProducts.map(function (product) {
    const safeId = product.replace(/[^a-zA-Z0-9]/g, "");
    return `
      <div class="panel-card">
        <div id="summary-${safeId}" class="summary-card"></div>
        <div class="chart-wrapper">
          <canvas id="chart-${safeId}"></canvas>
        </div>
      </div>
    `;
  }).join("");
}

// ===== TREND MARKER PLUGIN =====

const trendMarkerPlugin = {
  id: "trendMarkerPlugin",
  afterDatasetsDraw: function (chart) {
    const ctx = chart.ctx;
    const dataset = chart.data.datasets[0];
    const meta = chart.getDatasetMeta(0);

    if (!meta || !meta.data || meta.data.length < 2) return;

    ctx.save();
    ctx.font = "bold 12px Consolas";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let i = 1; i < dataset.data.length; i++) {
      const prev = dataset.data[i - 1];
      const curr = dataset.data[i];
      const point = meta.data[i];

      if (prev == null || curr == null || !point) continue;

      let symbol = "";
      let color = "";

      if (curr > prev) {
        symbol = "▲";
        color = "#16a34a";
      } else if (curr < prev) {
        symbol = "▼";
        color = "#dc2626";
      } else {
        continue;
      }

      const x = point.x;
      const y = point.y - 14;

      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fillStyle = "#f8fafc";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = color;
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.fillText(symbol, x, y + 0.5);
    }

    ctx.restore();
  }
};

// ===== CHARTS =====

function getYAxisConfig(product) {
  if (product === "DL-5") return { min: 0, max: 420, stepSize: 50 };
  if (product === "VE-03") return { min: 0, max: 60, stepSize: 10 };
  return { min: 0, max: 40, stepSize: 5 };
}

function initCharts() {
  Object.keys(charts).forEach(function (key) {
    charts[key].destroy();
  });

  charts = {};

  const activeProducts = getActiveProducts();

  activeProducts.forEach(function (product) {
    const safeId = product.replace(/[^a-zA-Z0-9]/g, "");
    const canvas = document.getElementById(`chart-${safeId}`);
    if (!canvas) return;

    const yAxis = getYAxisConfig(product);

    charts[product] = new Chart(canvas.getContext("2d"), {
      type: "line",
      plugins: [trendMarkerPlugin],
      data: {
        labels: FIXED_DAY_LABELS,
        datasets: [{
          label: product,
          data: [],
          fill: true,
          backgroundColor: PRODUCTS[product].color + "22",
          tension: 0.15,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 3,
          borderColor: "#111827",
          spanGaps: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          zoom: {
            pan: { enabled: true, mode: "x" },
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              mode: "x"
            }
          },
          tooltip: {
            callbacks: {
              label: function (context) {
                if (context.parsed.y == null) return "Sin dato";
                return `${context.parsed.y.toFixed(2)} ton`;
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: "Hora" },
            min: 0,
            max: FIXED_DAY_LABELS.length - 1,
            ticks: {
              autoSkip: true,
              maxTicksLimit: window.innerWidth < 768 ? 7 : 13
            },
            grid: { display: true, color: "#dbe2ea", lineWidth: 1 }
          },
          y: {
            min: yAxis.min,
            max: yAxis.max,
            title: { display: true, text: "Ton" },
            ticks: { stepSize: yAxis.stepSize },
            grid: { display: true, color: "#e5e7eb", lineWidth: 1 }
          }
        }
      }
    });
  });
}

function updateCharts() {
  const sourceHistory = getViewHistory();

  Object.keys(charts).forEach(function (product) {
    charts[product].data.labels = FIXED_DAY_LABELS;
    charts[product].data.datasets[0].data = buildFixedSeries(sourceHistory[product] || []);
    charts[product].update();
  });
}

// ===== MINI SILO CHARTS =====

function destroyMiniCharts() {
  Object.keys(siloMiniCharts).forEach(function (id) {
    if (siloMiniCharts[id]) {
      siloMiniCharts[id].destroy();
    }
  });

  siloMiniCharts = {};
}

function updateMiniSiloCharts() {
  if (mode !== "real") {
    destroyMiniCharts();
    return;
  }

  Object.keys(realTanks).forEach(function (id) {
    const canvas = document.getElementById("mini-matriz-" + id);
    if (!canvas) return;

    const data = buildFixedSeries(siloTrendReal[id] || []);

    siloMiniCharts[id] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: FIXED_DAY_LABELS,
        datasets: [{
          label: "% llenado",
          data: data,
          borderColor: "#111827",
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          backgroundColor: "rgba(17, 24, 39, 0.08)",
          tension: 0.25,
          spanGaps: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            callbacks: {
              label: function (context) {
                if (context.parsed.y == null) return "Sin dato";
                return context.parsed.y.toFixed(1) + "%";
              }
            }
          }
        },
        scales: {
          x: {
            display: true,
            min: 0,
            max: FIXED_DAY_LABELS.length - 1,
            ticks: {
              autoSkip: false,
              font: { size: 9 },
              callback: function (value) {
                const label = this.getLabelForValue(value);

                if (label === "07:00" || label === "12:00" || label === "19:00") {
                  return label;
                }

                return "";
              }
            },
            grid: {
              display: true,
              color: function (context) {
                const label = context.tick && context.tick.label;

                if (label === "07:00" || label === "12:00" || label === "19:00") {
                  return "#cbd5e1";
                }

                return "#edf2f7";
              },
              lineWidth: function (context) {
                const label = context.tick && context.tick.label;

                if (label === "07:00" || label === "12:00" || label === "19:00") {
                  return 1.2;
                }

                return 0.5;
              }
            }
          },
          y: {
            display: true,
            min: 0,
            max: 100,
            ticks: {
              stepSize: 50,
              font: { size: 9 },
              callback: function (value) {
                return value + "%";
              }
            },
            grid: {
              display: true,
              color: "#e5e7eb",
              lineWidth: 1
            }
          }
        }
      }
    });
  });
}

// ===== SUMMARY (CUADROS DE RESUMEN POR FECHA) =====

/**
 * Calcula el totalizador del producto a partir del historial de la fecha seleccionada.
 * Usa el último valor registrado del día como representación del stock de ese día.
 */
function computeHistoryTotals(historyForDate) {
  const totals = { "DL-5": 0, "VE-03": 0, "ASE": 0 };

  PRODUCT_ORDER.forEach(function (product) {
    const arr = historyForDate[product] || [];
    if (arr.length > 0) {
      // Último valor registrado del día = stock al cierre del turno
      totals[product] = Number(arr[arr.length - 1].value) || 0;
    }
  });

  return totals;
}

/**
 * Calcula el totalizador en tiempo real (modo real, día actual).
 */
function computeLiveTotals() {
  const viewTanks = getViewTanks();
  const totals = { "DL-5": 0, "VE-03": 0, "ASE": 0 };

  Object.keys(viewTanks).forEach(function (key) {
    const t = viewTanks[key];
    totals[t.product] += calculateMassTon(t.volume, t.product);
  });

  return totals;
}

/**
 * renderSummary — actualiza los cuadros de resumen según la fecha seleccionada.
 *
 * Lógica:
 *  - Si la fecha seleccionada es HOY (o no hay fecha): muestra totales en tiempo real
 *    + registro de turno 07h / 19h del día actual.
 *  - Si la fecha seleccionada es un día HISTÓRICO: muestra el último totalizador
 *    registrado en ese día + registro de turno 07h / 19h de esa fecha.
 */
function renderSummary() {
  const isToday = isSelectedDateToday();

  // Totales a mostrar
  let totals;
  if (mode === "demo") {
    totals = computeLiveTotals();
  } else if (isToday) {
    totals = computeLiveTotals();
  } else {
    // Día histórico: usar último valor del historial de esa fecha
    totals = historyTotals || computeHistoryTotals(historyReal);
  }

  // Datos de turno a mostrar
  // historyTurnData se actualiza al cambiar fecha (evento "turnData" con date)
  // turnData (sin prefijo) es el turno del día actual en vivo
  const activeTurn = (mode === "real" && !isToday) ? historyTurnData : turnData;
  const start = activeTurn.start || activeTurn.data
    ? (activeTurn.data ? (activeTurn.data.start || {}) : (activeTurn.start || {}))
    : {};
  const end = activeTurn.end || activeTurn.data
    ? (activeTurn.data ? (activeTurn.data.end || {}) : (activeTurn.end || {}))
    : {};

  // Etiqueta de fecha para el encabezado del cuadro
  const dateLabel = isToday
    ? "Hoy"
    : (selectedHistoryDate || getTodayKey());

  Object.keys(charts).forEach(function (product) {
    const safeId = product.replace(/[^a-zA-Z0-9]/g, "");
    const el = document.getElementById(`summary-${safeId}`);
    if (!el) return;

    if (mode === "real") {
      el.innerHTML = `
        <div style="background:${PRODUCTS[product].color}; padding:8px; border-radius:8px;">
          <strong>${product}</strong> &mdash; <span style="font-size:0.85em; opacity:0.9">${dateLabel}</span><br>
          <strong>Totalizador:</strong> ${totals[product].toFixed(1)} ton<br>
          <strong>Registro turno:</strong>
          07h: ${start[product] != null ? Number(start[product]).toFixed(1) : "-"} ton |
          19h: ${end[product] != null ? Number(end[product]).toFixed(1) : "-"} ton
        </div>
      `;
    } else {
      el.innerHTML = `
        <div style="background:${PRODUCTS[product].color}; padding:8px; border-radius:8px;">
          <strong>${product}</strong><br>
          <strong>Totalizador:</strong> ${totals[product].toFixed(1)} ton<br>
          <strong>Modo:</strong> Demo
        </div>
      `;
    }
  });
}

// ===== SILO PRODUCT CONFIG =====

function saveSiloProductConfig(id, product) {
  socket.emit("setSiloProduct", { tanque: id, product: product });
}

// ===== DEMO HISTORY =====

function updateDemoHistory() {
  const label = getRounded5MinLabel();
  const totals = { "DL-5": 0, "VE-03": 0, "ASE": 0 };

  Object.keys(demoTanks).forEach(function (key) {
    const t = demoTanks[key];
    totals[t.product] += calculateMassTon(t.volume, t.product);
  });

  Object.keys(totals).forEach(function (product) {
    const arr = historyDemo[product];
    const lastEntry = arr[arr.length - 1];

    if (!lastEntry) {
      arr.push({ time: label, value: totals[product] });
    } else if (lastEntry.time !== label) {
      arr.push({ time: label, value: totals[product] });
    } else {
      lastEntry.value = totals[product];
    }
  });
}

// ===== EXPORT =====

function exportData() {
  window.location.href = "/matriz/export-data";
}

function exportTrend() {
  window.location.href = "/matriz/export-daily-summary";
}

// ===== RENDER PRINCIPAL =====

function render() {
  const viewTanks = getViewTanks();
  const grid = document.getElementById("gridMatriz");
  if (!grid) return;

  destroyMiniCharts();
  grid.innerHTML = "";

  Object.keys(viewTanks).forEach(function (id) {
    const t = viewTanks[id];
    const product = PRODUCTS[t.product];
    const percent = Math.max(0, Math.min(100, t.percent || 0));

    let coneFill = 0;
    let rectFill = 0;

    if (t.levelMeters <= CONE_HEIGHT) {
      coneFill = (t.levelMeters / CONE_HEIGHT) * 60;
      rectFill = 0;
    } else {
      coneFill = 60;
      rectFill = ((t.levelMeters - CONE_HEIGHT) / CYL_HEIGHT) * 100;
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
            <div>${t.levelMeters.toFixed(2)} m</div>
            <div>${t.volume.toFixed(2)} m³</div>
            <div class="tank-mass">${calculateMassTon(t.volume, t.product).toFixed(2)} ton</div>
            <div>${product.density} kg/m³</div>
          </div>

          <div class="gauge-container compact-gauge">
            ${createGauge(percent, product.color)}
          </div>
        </div>

        <div class="tank-wrapper">
          <div class="scale">
            <div>5.92</div>
            <div>5</div>
            <div>4</div>
            <div>3</div>
            <div>2</div>
            <div>1</div>
            <div>0</div>
          </div>

          <div class="tank-container">
            <div class="tank-rect">
              <div class="liquid-rect" style="height:${rectFill}%; background:${product.color}"></div>
            </div>

            <div class="tank-cone">
              <div class="liquid-cone" style="border-top:${coneFill}px solid ${product.color}"></div>
            </div>
          </div>

          <div class="mini-chart-container">
            <canvas id="mini-matriz-${id}"></canvas>
          </div>
        </div>
      </div>

      <select class="product-select" data-id="${id}" ${mode === "real" ? "disabled" : ""}>
        ${Object.keys(PRODUCTS).map(function (p) {
          return `<option value="${p}" ${p === t.product ? "selected" : ""}>${p}</option>`;
        }).join("")}
      </select>
    `;

    grid.appendChild(div);
  });

  document.querySelectorAll(".product-select").forEach(function (select) {
    select.addEventListener("change", function (e) {
      const id = e.target.dataset.id;
      const product = e.target.value;

      setProductForCurrentMode(id, product);

      if (mode === "real") {
        saveSiloProductConfig(id, product);
      }

      render();
    });
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

socket.on("nivel", function (data) {
  if (!data) return;

  if (data.serverTime) {
    lastMqttUpdate = data.serverTime;
  }

  mqttSignalOk = true;
  lastMqttHeartbeat = Date.now();

  updateMqttStatus();
});

socket.on("siloState", function (backendState) {
  Object.keys(backendState || {}).forEach(function (tanque) {
    if (!realTanks[tanque]) return;

    realTanks[tanque] = {
      levelMeters: backendState[tanque].levelMeters || 0,
      volume: backendState[tanque].volume || 0,
      percent: backendState[tanque].percent || 0,
      product: realTanks[tanque].product
    };
  });

  if (mode === "real") render();
});

socket.on("turnData", function (data) {
  if (!data) return;

  // El servidor envía { date, data: { start, end } } cuando se consulta por fecha
  // o el formato antiguo { start, end } para el día en vivo
  const isHistorical = data.date && data.date !== getTodayKey();

  if (isHistorical) {
    // Guardar turno histórico de la fecha seleccionada
    historyTurnData = data;
  } else {
    // Turno del día actual (en vivo o hoy)
    turnData = data.data ? data.data : data;
  }

  if (mode === "real") renderSummary();
});

socket.on("siloConfig", function (config) {
  Object.keys(config || {}).forEach(function (tanque) {
    if (PRODUCTS[config[tanque]]) {
      if (realTanks[tanque]) {
        realTanks[tanque].product = config[tanque];
      }

      if (!demoProductsInitialized && demoTanks[tanque]) {
        demoTanks[tanque].product = config[tanque];
      }
    }
  });

  demoProductsInitialized = true;
  render();
});

socket.on("historyDates", function (dates) {
  availableHistoryDates = dates || [];

  if (!selectedHistoryDate && availableHistoryDates.length > 0) {
    selectedHistoryDate = availableHistoryDates[availableHistoryDates.length - 1];
  }

  renderDateSelector();

  socket.emit("getHistoryData", { date: selectedHistoryDate });
  socket.emit("getSiloTrendData", { date: selectedHistoryDate });
  socket.emit("getTurnData", { date: selectedHistoryDate });
});

socket.on("historyData", function (payload) {
  if (payload && payload.date && selectedHistoryDate && payload.date !== selectedHistoryDate) {
    return;
  }

  const backendHistory = payload && payload.history ? payload.history : payload;

  historyReal = {
    "DL-5": backendHistory && backendHistory["DL-5"] ? backendHistory["DL-5"] : [],
    "VE-03": backendHistory && backendHistory["VE-03"] ? backendHistory["VE-03"] : [],
    "ASE": backendHistory && backendHistory["ASE"] ? backendHistory["ASE"] : []
  };

  // Recalcular totales históricos a partir del nuevo historial recibido
  historyTotals = computeHistoryTotals(historyReal);

  if (mode === "real") render();
});

socket.on("siloTrendData", function (payload) {
  if (payload && payload.date && selectedHistoryDate && payload.date !== selectedHistoryDate) {
    return;
  }

  siloTrendReal = payload && payload.history ? payload.history : {};

  if (mode === "real") render();
});

// ===== SOLICITUD INICIAL DE DATOS =====

function requestRealData() {
  socket.emit("getTurnData", { date: getTodayKey() });
  socket.emit("getSiloConfig");
  socket.emit("getHistoryDates");
  socket.emit("getHistoryData", { date: selectedHistoryDate });
  socket.emit("getSiloTrendData", { date: selectedHistoryDate });
  socket.emit("getSiloState");
}

// ===== DEMO INTERVAL =====

setInterval(function () {
  Object.keys(demoTanks).forEach(function (id) {
    const current = demoTanks[id].levelMeters || 3;
    const next = Math.max(0, Math.min(MAX_HEIGHT, current + (Math.random() - 0.5) * 0.3));
    const volume = calculateVolume(next);
    const percent = (next / MAX_HEIGHT) * 100;

    demoTanks[id] = {
      levelMeters: next,
      volume: volume,
      percent: percent,
      product: demoTanks[id].product
    };
  });

  updateDemoHistory();

  if (mode === "demo") render();
}, 2000);

// ===== MQTT WATCHDOG =====

setInterval(function () {
  if (!lastMqttHeartbeat) {
    mqttSignalOk = false;
    updateMqttStatus();
    return;
  }

  if (Date.now() - lastMqttHeartbeat > 300000) {
    mqttSignalOk = false;
    updateMqttStatus();
  }
}, 1000);

// ===== EVENT LISTENERS =====

document.querySelectorAll('input[name="mode"]').forEach(function (radio) {
  radio.addEventListener("change", function (e) {
    mode = e.target.value;

    if (mode === "real") {
      requestRealData();
    }

    render();
  });
});

document.getElementById("exportBtnMatriz").addEventListener("click", exportData);
document.getElementById("exportTrendBtnMatriz").addEventListener("click", exportTrend);

// DESPUÉS
let lastKnownWidth = window.innerWidth;

window.addEventListener("resize", function () {
  const currentWidth = window.innerWidth;

  // Ignorar si solo cambió la altura (scroll en móvil oculta/muestra barra URL)
  if (currentWidth === lastKnownWidth) return;

  lastKnownWidth = currentWidth;

  renderTopPanel();
  initCharts();
  updateCharts();
  destroyMiniCharts();
  updateMiniSiloCharts();
});

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

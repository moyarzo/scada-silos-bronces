// ===== PESTAÑA KPI =====
// Consumo diario, recepciones y uso por silo de los últimos 30 días (desde el historial).
// Datos: /matriz/kpi y /nitrato/kpi (calculados en el servidor, lib/kpi.js).
// Se carga al abrir la pestaña y se actualiza cada 5 minutos mientras está visible.

(function () {

const PRODUCT_ORDER = ["DL-5", "VE-03", "ASE", "Nitrato"];
const PRODUCT_COLOR = { "DL-5": "#2563eb", "VE-03": "#16a34a", "ASE": "#ea580c", "Nitrato": "#ca8a04" };
const RECEPCION_COLOR = "#0891b2";   // validado contra los 4 colores de producto (CVD / contraste)
const REFRESH_MS = 5 * 60 * 1000;

let charts = {};
let timer = null;
let lastData = null;

// ===== UTILIDADES =====

function fmt(v, dec) {
  return Number(v || 0).toLocaleString("es-CL", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function dayLabel(dateKey, isLast) {
  const p = dateKey.split("-");
  return isLast ? "Hoy" : p[2] + "-" + p[1];
}

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function sum(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }

function noiseText(s) {
  const vals = (s.ruido || []).filter((v, i) => s.conDatos[i]);
  return vals.length ? "±" + fmt(sum(vals) / vals.length, 2) + " t" : "—";
}

// ===== CARGA =====

function load() {
  const container = document.getElementById("kpiContent");
  if (container && lastData) container.classList.add("kpi-loading");

  Promise.all([
    fetch("/matriz/kpi").then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("/nitrato/kpi").then(r => r.ok ? r.json() : null).catch(() => null)
  ]).then(([matriz, nitrato]) => {
    lastData = { matriz, nitrato };
    render(lastData);
    if (container) container.classList.remove("kpi-loading");
  });
}

// ===== RENDER =====

function collectProducts(data) {
  const out = {};
  [data.matriz, data.nitrato].forEach(src => {
    if (!src || !src.products) return;
    Object.keys(src.products).forEach(p => { out[p] = { ...src.products[p], days: src.days }; });
  });
  return PRODUCT_ORDER.filter(p => out[p]).map(p => ({ name: p, ...out[p] }));
}

function renderTiles(products) {
  const el = document.getElementById("kpiTiles");
  if (!el) return;
  el.innerHTML = products.map(p => {
    const n = p.consumo.length;
    const hoy = p.consumo[n - 1] || 0;
    // Promedio diario: solo días completos con datos (sin hoy)
    const fullDays = p.consumo.slice(0, n - 1).filter((v, i) => p.conDatos[i]);
    const avg = fullDays.length ? sum(fullDays) / fullDays.length : 0;
    const total = sum(p.consumo);
    const rec = sum(p.recepcion);
    const nRec = sum(p.recargas);
    return `
      <div class="kpi-tile" style="border-top-color:${PRODUCT_COLOR[p.name]}">
        <div class="kpi-tile-title"><span class="kpi-dot" style="background:${PRODUCT_COLOR[p.name]}"></span>${p.name}</div>
        <div class="kpi-tile-grid">
          <div><div class="kpi-label">Consumo hoy</div><div class="kpi-value">${fmt(hoy, 1)} t</div></div>
          <div><div class="kpi-label">Promedio diario</div><div class="kpi-value">${fmt(avg, 1)} t</div>
               <div class="kpi-sub">${fullDays.length} días con datos</div></div>
          <div><div class="kpi-label">Consumo 30 días</div><div class="kpi-value">${fmt(total, 1)} t</div></div>
          <div><div class="kpi-label">Recepciones 30 días</div><div class="kpi-value">${fmt(rec, 1)} t</div>
               <div class="kpi-sub">${nRec} ${nRec === 1 ? "recarga" : "recargas"}</div></div>
        </div>
      </div>`;
  }).join("");
}

function renderCharts(products) {
  const el = document.getElementById("kpiCharts");
  if (!el) return;

  Object.keys(charts).forEach(k => charts[k].destroy());
  charts = {};

  el.innerHTML = products.map(p => {
    const id = p.name.replace(/[^a-zA-Z0-9]/g, "");
    return `
      <div class="panel-card kpi-chart-card">
        <div class="kpi-chart-title">${p.name} · consumo y recepciones diarias (t)</div>
        <div class="kpi-chart-wrapper"><canvas id="kpiChart-${id}"></canvas></div>
      </div>`;
  }).join("");

  products.forEach(p => {
    const id = p.name.replace(/[^a-zA-Z0-9]/g, "");
    const canvas = document.getElementById("kpiChart-" + id);
    if (!canvas) return;
    const labels = p.days.map((d, i) => dayLabel(d, i === p.days.length - 1));
    const bar = { borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", categoryPercentage: 0.72, barPercentage: 0.9 };

    charts[p.name] = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Consumo", data: p.consumo, backgroundColor: PRODUCT_COLOR[p.name], ...bar },
          { label: "Recepción", data: p.recepcion, backgroundColor: RECEPCION_COLOR, ...bar }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, position: "top", align: "end",
            labels: { boxWidth: 12, boxHeight: 12, color: scadaColor("--text-2", "#334155"), font: { size: 12 } } },
          tooltip: {
            callbacks: {
              title: items => p.days[items[0].dataIndex],
              label: ctx => `${ctx.dataset.label}: ${fmt(ctx.parsed.y, 1)} t` +
                (ctx.datasetIndex === 1 && p.recargas[ctx.dataIndex] ? ` (${p.recargas[ctx.dataIndex]} recarga${p.recargas[ctx.dataIndex] > 1 ? "s" : ""})` : "")
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: scadaColor("--chart-text", "#475569"), font: { size: 10 }, autoSkip: true, maxRotation: 0, maxTicksLimit: window.innerWidth < 768 ? 6 : 15 } },
          y: { beginAtZero: true, title: { display: true, text: "t", color: scadaColor("--chart-text", "#475569") },
               grid: { color: scadaColor("--chart-grid", "#e5e7eb") }, border: { display: false }, ticks: { color: scadaColor("--chart-text", "#475569") } }
        }
      }
    });
  });
}

function renderSiloTable(elId, src, title) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!src || !src.silos) { el.innerHTML = `<div class="kpi-empty">Sin datos de ${title}</div>`; return; }

  const days = src.days;
  const silos = Object.keys(src.silos);
  // Intensidad relativa al máximo diario de cada producto (secuencial de un solo tono)
  const maxBy = {};
  silos.forEach(id => {
    const s = src.silos[id];
    maxBy[s.product] = Math.max(maxBy[s.product] || 0, ...s.consumo);
  });
  const alphaFor = (v, product) => {
    const m = maxBy[product] || 0;
    if (!v || !m) return 0;
    const steps = [0.12, 0.24, 0.38, 0.55];
    return steps[Math.min(steps.length - 1, Math.floor((v / m) * steps.length))];
  };

  const head = `<tr><th class="kpi-sticky">Silo</th>${days.map((d, i) => `<th title="${d}">${dayLabel(d, i === days.length - 1)}</th>`).join("")}
    <th class="kpi-total">Consumo 30 d</th><th class="kpi-total">Recepción 30 d</th><th class="kpi-total">Recargas</th>
    <th class="kpi-total" title="Saltos bruscos descartados en 30 días (cortes de energía o reinicios del sensor/HMI). No se cuentan como consumo, recepción ni recarga.">Saltos</th>
    <th class="kpi-total" title="Ruido promedio de la lectura del radar (1σ, en toneladas). Un aumento sostenido puede indicar un problema del sensor.">Ruido radar</th></tr>`;

  const rows = silos.map(id => {
    const s = src.silos[id];
    const color = PRODUCT_COLOR[s.product] || "#64748b";
    const cells = days.map((d, i) => {
      if (!s.conDatos[i]) return `<td class="kpi-nodata" title="${d}: sin datos">·</td>`;
      const v = s.consumo[i];
      const a = alphaFor(v, s.product);
      const rec = s.recepcion[i] ? `\nRecepción: ${fmt(s.recepcion[i], 1)} t` : "";
      return `<td style="background:${a ? hexToRgba(color, a) : "transparent"}" title="${d}\nConsumo: ${fmt(v, 1)} t${rec}">${v ? fmt(v, 1) : ""}</td>`;
    }).join("");
    return `<tr>
      <th class="kpi-sticky"><span class="kpi-dot" style="background:${color}"></span>Silo ${id.replace("tanque", "")}
        <span class="kpi-prod">${s.product}</span></th>
      ${cells}
      <td class="kpi-total">${fmt(sum(s.consumo), 1)}</td>
      <td class="kpi-total">${fmt(sum(s.recepcion), 1)}</td>
      <td class="kpi-total">${sum(s.recargas)}</td>
      <td class="kpi-total">${sum(s.saltos || [])}</td>
      <td class="kpi-total">${noiseText(s)}</td></tr>`;
  }).join("");

  el.innerHTML = `
    <div class="kpi-table-title">${title} · consumo diario por silo (t)</div>
    <div class="kpi-table-scroll"><table class="kpi-table">${head}${rows}</table></div>`;

  const scroll = el.querySelector(".kpi-table-scroll");
  if (scroll) scroll.scrollLeft = scroll.scrollWidth;   // mostrar los días más recientes
}

function render(data) {
  const products = collectProducts(data);
  renderTiles(products);
  renderCharts(products);
  renderSiloTable("kpiSiloMatriz", data.matriz, "Silos Matriz");
  renderSiloTable("kpiSiloNitrato", data.nitrato, "Silos Nitrato");
}

// ===== CICLO DE VIDA DE LA PESTAÑA =====

function onPage(page) {
  if (page === "kpi") {
    load();
    if (!timer) timer = setInterval(load, REFRESH_MS);
  } else if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

document.addEventListener("scada:pagechange", e => onPage(e.detail && e.detail.page));

let lastWidth = window.innerWidth;
window.addEventListener("resize", () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  if (document.body.dataset.page === "kpi" && lastData) render(lastData);
});

// Si la página se abre directamente en #kpi
if (document.body.dataset.page === "kpi") onPage("kpi");

})();

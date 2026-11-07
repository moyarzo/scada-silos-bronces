// ===== NAVEGACIÓN Y SESIÓN (común a Matriz y Nitrato) =====

// Conexión principal: solo para la lista de usuarios conectados.
// Matriz y Nitrato usan sus propias conexiones (/matriz y /nitrato).
const socket = io();

// ===== SUBPÁGINAS =====

const PAGES = ["totales", "matriz", "nitrato", "kpi"];
const DEFAULT_PAGE = "totales";   // pestaña principal al abrir el SCADA
const ADMIN_PAGES = [];               // subpáginas visibles solo para el usuario Admin (hoy ninguna)
let isAdminUser = false;

function getPageFromHash() {
  const page = (window.location.hash || "").replace("#", "");
  return PAGES.indexOf(page) >= 0 ? page : DEFAULT_PAGE;
}

function showPage(page) {
  if (ADMIN_PAGES.indexOf(page) >= 0 && !isAdminUser) {
    page = DEFAULT_PAGE;
    history.replaceState(null, "", "#" + DEFAULT_PAGE);
  }
  document.body.dataset.page = page;

  document.querySelectorAll(".page").forEach(function (section) {
    section.hidden = section.dataset.page !== page;
  });

  document.querySelectorAll(".page-tab").forEach(function (tab) {
    const active = tab.dataset.page === page;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });

  // Matriz y Nitrato redibujan sus gráficos con el tamaño visible
  document.dispatchEvent(new CustomEvent("scada:pagechange", { detail: { page: page } }));
}

document.querySelectorAll(".page-tab").forEach(function (tab) {
  tab.addEventListener("click", function () {
    if (window.location.hash !== "#" + tab.dataset.page) {
      window.location.hash = tab.dataset.page;   // dispara hashchange → showPage
    } else {
      showPage(tab.dataset.page);
    }
  });
});

window.addEventListener("hashchange", function () {
  showPage(getPageFromHash());
});

// Estado inicial (antes de que matriz.js / nitrato.js dibujen)
(function initPage() {
  let page = getPageFromHash();
  if (ADMIN_PAGES.indexOf(page) >= 0) page = DEFAULT_PAGE;   // se habilita al confirmar que es Admin
  document.body.dataset.page = page;
  document.querySelectorAll(".page").forEach(function (section) {
    section.hidden = section.dataset.page !== page;
  });
  document.querySelectorAll(".page-tab").forEach(function (tab) {
    tab.classList.toggle("active", tab.dataset.page === page);
    tab.setAttribute("aria-selected", tab.dataset.page === page ? "true" : "false");
  });
})();

// ===== ESTADO DE SEÑAL MQTT (único para Matriz y Nitrato) =====
// matriz.js y nitrato.js reportan aquí su señal; se muestra un solo estado:
// activo si cualquiera de los dos recibió datos recientemente, con la hora del último dato.

window.scadaMqttStatus = (function () {
  const state = {};

  function render() {
    const el = document.getElementById("mqttStatus");
    if (!el) return;

    let ok = false;
    let lastTime = "--:--:--";
    let lastBeat = 0;

    Object.keys(state).forEach(function (key) {
      const s = state[key];
      if (s.ok) ok = true;
      if (s.heartbeat && s.heartbeat >= lastBeat) {
        lastBeat = s.heartbeat;
        lastTime = s.time;
      }
    });

    el.textContent = ok
      ? `🟢 MQTT Activo (${lastTime})`
      : `🔴 Sin señal (${lastTime})`;
  }

  return {
    update: function (system, ok, time, heartbeat) {
      state[system] = { ok: !!ok, time: time || "--:--:--", heartbeat: heartbeat || 0 };
      render();
    }
  };
})();

// ===== TOTALIZADORES: TABLA DE TURNO + GAUGE DE CAPACIDAD (común a Matriz y Nitrato) =====
// Se dibuja bajo el gráfico de cada producto en la pestaña "Totalizadores".

window.scadaTotals = (function () {
  function fmt(v) {
    return v != null && !isNaN(v) ? Number(v).toFixed(1) + " t" : "—";
  }

  function capacityGauge(percent, color) {
    const radius = 62;
    const circumference = Math.PI * radius;
    const shown = Math.max(0, Math.min(100, percent));
    const progress = (shown / 100) * circumference;
    return `
      <svg viewBox="0 0 160 96" class="cap-gauge-svg" aria-hidden="true">
        <path d="M18 84 A62 62 0 0 1 142 84" stroke="#e5e7eb" stroke-width="14" fill="none"></path>
        <path d="M18 84 A62 62 0 0 1 142 84" stroke="${color}" stroke-width="14" fill="none"
          stroke-dasharray="${circumference}" stroke-dashoffset="${circumference - progress}"
          style="transition: stroke-dashoffset 0.6s ease;"></path>
        <text x="14" y="96" font-size="11" fill="#64748b">0%</text>
        <text x="146" y="96" font-size="11" fill="#64748b" text-anchor="end">100%</text>
      </svg>`;
  }

  /**
   * opts: { product, color, start, end, total, capacity, isDemo, isToday }
   */
  function renderShiftAndCapacity(el, opts) {
    if (!el) return;

    let rows;
    if (opts.isDemo) {
      rows = `<tr><td colspan="2" class="shift-empty">Modo demo: sin registro de turno</td></tr>`;
    } else {
      let variation = null, variationLabel = "Variación turno";
      if (opts.start != null && opts.end != null) {
        variation = opts.end - opts.start;
      } else if (opts.start != null && opts.isToday) {
        variation = opts.total - opts.start;
        variationLabel = "Variación (en curso)";
      }
      const varClass = variation == null ? "" : (variation > 0 ? "var-pos" : variation < 0 ? "var-neg" : "");
      const varText = variation == null ? "—" : (variation > 0 ? "+" : "") + variation.toFixed(1) + " t";
      rows = `
        <tr><td>Inicio turno (07:00)</td><td>${fmt(opts.start)}</td></tr>
        <tr><td>Cierre turno (19:00)</td><td>${fmt(opts.end)}</td></tr>
        <tr class="shift-var"><td>${variationLabel}</td><td class="${varClass}">${varText}</td></tr>`;
    }

    let gauge;
    if (opts.capacity) {
      const percent = (opts.total / opts.capacity) * 100;
      gauge = `
        <div class="cap-gauge">
          <div class="cap-gauge-title">Capacidad planta</div>
          ${capacityGauge(percent, opts.color)}
          <div class="cap-gauge-value" style="color:${opts.color}">${percent.toFixed(1)}%</div>
          <div class="cap-gauge-detail">${opts.total.toFixed(1)} / ${opts.capacity} t</div>
        </div>`;
    } else {
      gauge = `
        <div class="cap-gauge">
          <div class="cap-gauge-title">Capacidad planta</div>
          <div class="cap-gauge-detail">Sin capacidad definida</div>
        </div>`;
    }

    el.innerHTML = `
      <div class="shift-table-wrap">
        <table class="shift-table">
          <thead><tr><th colspan="2" style="border-color:${opts.color}">Registro de turno</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${gauge}`;
  }

  return { renderShiftAndCapacity: renderShiftAndCapacity };
})();

// ===== SESIÓN =====

// Quién soy (usa la cookie de sesión ya activa).
// Los botones de descarga (Excel / historial) solo se muestran al usuario Admin.
fetch("/whoami")
  .then(function (res) { return res.json(); })
  .then(function (data) {
    document.getElementById("currentUser").innerText = "Usuario: " + data.user;

    isAdminUser = !!data.isAdmin;
    document.querySelectorAll(".admin-only").forEach(function (el) {
      el.hidden = !data.isAdmin;
    });

    // Si se abrió directamente una subpágina de Admin (ej. /#kpi), mostrarla ahora
    const requested = getPageFromHash();
    if (ADMIN_PAGES.indexOf(requested) >= 0) {
      if (isAdminUser) showPage(requested);
      else if (window.location.hash) window.location.hash = DEFAULT_PAGE;
    }
  })
  .catch(function () {});

// Lista de usuarios conectados en tiempo real, emitida por el servidor.
socket.on("connectedUsers", function (users) {
  document.getElementById("connectedUsers").innerText =
    "Conectados: " + users.join(", ");
});

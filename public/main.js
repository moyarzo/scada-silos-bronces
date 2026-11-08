// ===== NAVEGACIÓN Y SESIÓN (común a Matriz y Nitrato) =====

// Conexión principal: solo para la lista de usuarios conectados.
// Matriz y Nitrato usan sus propias conexiones (/matriz y /nitrato).
const socket = io();

// ===== SUBPÁGINAS =====

const PAGES = ["totales", "matriz", "nitrato", "kpi", "eventos"];
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

// ===== COLORES DEL TEMA (variables CSS de styles.css) =====
// scadaColor("--chart-grid", "#e5e7eb") → valor de la variable, o el respaldo si no existe.
window.scadaColor = function (name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};
if (window.Chart) {
  Chart.defaults.color = scadaColor("--chart-text", "#666666");
  Chart.defaults.borderColor = scadaColor("--chart-grid", "#e5e7eb");
}

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

    // Indicador junto a la versión: ONLINE (verde) / OFFLINE (rojo); la hora del último dato en el tooltip
    el.textContent = ok ? "ONLINE" : "OFFLINE";
    el.classList.toggle("online", ok);
    el.classList.toggle("offline", !ok);
    el.title = t(ok ? "Recibiendo datos MQTT · último dato: {t}" : "Sin datos MQTT · último dato: {t}", { t: lastTime });
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
        <path d="M18 84 A62 62 0 0 1 142 84" stroke="${scadaColor("--gauge-track", "#e5e7eb")}" stroke-width="14" fill="none"></path>
        <path d="M18 84 A62 62 0 0 1 142 84" stroke="${color}" stroke-width="14" fill="none"
          stroke-dasharray="${circumference}" stroke-dashoffset="${circumference - progress}"
          style="transition: stroke-dashoffset 0.6s ease;"></path>
        <text x="14" y="96" font-size="11" fill="${scadaColor("--muted", "#64748b")}">0%</text>
        <text x="146" y="96" font-size="11" fill="${scadaColor("--muted", "#64748b")}" text-anchor="end">100%</text>
      </svg>`;
  }

  /**
   * opts: { product, color, start, end, total, capacity, isDemo, isToday }
   */
  function renderShiftAndCapacity(el, opts) {
    if (!el) return;

    let rows;
    if (opts.isDemo) {
      rows = `<tr><td colspan="2" class="shift-empty">${t("Modo demo: sin registro de turno")}</td></tr>`;
    } else {
      let variation = null, variationLabel = t("Variación turno");
      if (opts.start != null && opts.end != null) {
        variation = opts.end - opts.start;
      } else if (opts.start != null && opts.isToday) {
        variation = opts.total - opts.start;
        variationLabel = t("Variación (en curso)");
      }
      const varClass = variation == null ? "" : (variation > 0 ? "var-pos" : variation < 0 ? "var-neg" : "");
      const varText = variation == null ? "—" : (variation > 0 ? "+" : "") + variation.toFixed(1) + " t";
      rows = `
        <tr><td>${t("Inicio turno (07:00)")}</td><td>${fmt(opts.start)}</td></tr>
        <tr><td>${t("Cierre turno (19:00)")}</td><td>${fmt(opts.end)}</td></tr>
        <tr class="shift-var"><td>${variationLabel}</td><td class="${varClass}">${varText}</td></tr>`;
    }

    let gauge;
    if (opts.capacity) {
      const percent = (opts.total / opts.capacity) * 100;
      gauge = `
        <div class="cap-gauge">
          <div class="cap-gauge-title">${t("Capacidad planta")}</div>
          ${capacityGauge(percent, opts.color)}
          <div class="cap-gauge-value" style="color:${opts.color}">${percent.toFixed(1)}%</div>
          <div class="cap-gauge-detail">${opts.total.toFixed(1)} / ${opts.capacity} t</div>
        </div>`;
    } else {
      gauge = `
        <div class="cap-gauge">
          <div class="cap-gauge-title">${t("Capacidad planta")}</div>
          <div class="cap-gauge-detail">${t("Sin capacidad definida")}</div>
        </div>`;
    }

    el.innerHTML = `
      <div class="shift-table-wrap">
        <table class="shift-table">
          <thead><tr><th colspan="2" style="border-color:${opts.color}">${t("Registro de turno")}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${gauge}`;
  }

  return { renderShiftAndCapacity: renderShiftAndCapacity };
})();

// ===== SESIÓN =====

// Ícono de usuario (silueta), toma el color del texto
const USER_ICON = '<svg class="user-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<circle cx="12" cy="7.2" r="4.2" fill="currentColor"/>' +
  '<path d="M3.5 21.5a8.5 8.5 0 0 1 17 0z" fill="currentColor"/></svg>';

// Quién soy (usa la cookie de sesión ya activa).
// Los botones de descarga (Excel / historial) solo se muestran al usuario Admin.
fetch("/whoami")
  .then(function (res) { return res.json(); })
  .then(function (data) {
    const userEl = document.getElementById("currentUser");
    userEl.innerHTML = USER_ICON + '<span class="current-user-name"></span>';
    userEl.querySelector(".current-user-name").textContent = data.user;
    userEl.title = t("Usuario") + ": " + data.user;
    if (data.prefs) syncPrefs(data.prefs);

    // Planta bajo el logo, pestaña del navegador y versión junto a ARGOSS
    if (data.planta) {
      document.getElementById("plantName").textContent = data.planta;
      document.title = "ARGOSS · " + data.planta.replace(/^Planta\s+/i, "");
    }
    if (data.version) {
      const ver = document.getElementById("appVersion");
      ver.textContent = "v" + data.version;
      ver.title = "ARGOSS v" + data.version + (data.commit ? " · " + data.commit : "");
    }

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

// Cambio de modo DEMO / REAL (selector solo visible para Admin): se registra en la pestaña Eventos
document.querySelectorAll('input[name="mode"]').forEach(function (radio) {
  radio.addEventListener("change", function () {
    if (radio.checked) socket.emit("modoCambiado", radio.value);
  });
});

// Lista de usuarios conectados en tiempo real, emitida por el servidor.
// (La lista de usuarios conectados ya no se muestra en la cabecera: las conexiones quedan en Eventos)

// ===== CONFIGURACIÓN DE USUARIO (botón ⚙): apariencia e idioma =====
// Se guarda por usuario en el servidor (POST /preferencias) y en este navegador (i18n.js la aplica
// al cargar). Al cambiar algo la página se recarga para aplicar colores de gráficos y textos.

const PREF_KEYS = { tema: "argoss.tema", idioma: "argoss.idioma" };

function readLocalPref(key, fallback) {
  try { return localStorage.getItem(PREF_KEYS[key]) || fallback; } catch (e) { return fallback; }
}

function writeLocalPref(key, value) {
  try { localStorage.setItem(PREF_KEYS[key], value); } catch (e) {}
}

function currentPrefs() {
  return { tema: readLocalPref("tema", "oscuro"), idioma: readLocalPref("idioma", "es") };
}

function markPrefs(prefs) {
  document.querySelectorAll("#settingsPanel .segmented").forEach(function (group) {
    const key = group.getAttribute("data-pref");
    group.querySelectorAll("button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-value") === prefs[key]));
    });
  });
}

// Preferencias del servidor (las de este usuario en cualquier equipo): si difieren de las del
// navegador, se copian y se recarga una vez para aplicarlas.
function syncPrefs(serverPrefs) {
  const local = currentPrefs();
  let changed = false;
  Object.keys(PREF_KEYS).forEach(function (k) {
    if (serverPrefs[k] && serverPrefs[k] !== local[k]) { writeLocalPref(k, serverPrefs[k]); changed = true; }
  });
  if (changed) window.location.reload();
  else markPrefs(local);
}

(function setupSettings() {
  const btn = document.getElementById("settingsBtn");
  const panel = document.getElementById("settingsPanel");
  if (!btn || !panel) return;

  function open(show) {
    panel.hidden = !show;
    btn.setAttribute("aria-expanded", String(show));
    if (show) markPrefs(currentPrefs());
  }

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    open(panel.hidden);
  });
  panel.addEventListener("click", function (e) { e.stopPropagation(); });
  document.addEventListener("click", function () { if (!panel.hidden) open(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !panel.hidden) { open(false); btn.focus(); }
  });

  panel.querySelectorAll(".segmented button").forEach(function (b) {
    b.addEventListener("click", function () {
      const key = b.parentElement.getAttribute("data-pref");
      const value = b.getAttribute("data-value");
      if (currentPrefs()[key] === value) return;
      writeLocalPref(key, value);
      markPrefs(currentPrefs());
      const body = {}; body[key] = value;
      fetch("/preferencias", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .catch(function () {})
        .then(function () { window.location.reload(); });
    });
  });

  markPrefs(currentPrefs());
})();

// Textos fijos de la página en el idioma elegido
applyI18n();

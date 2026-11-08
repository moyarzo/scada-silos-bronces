// ===== IDIOMA Y APARIENCIA (se carga en <head>, antes que el resto) =====
// - Aplica el tema guardado en este navegador antes de pintar la página (sin parpadeo).
// - t("clave", {var}) devuelve el texto en el idioma elegido; applyI18n() traduce los elementos con
//   data-i18n, data-i18n-title, data-i18n-placeholder y data-i18n-aria.
// La preferencia de cada usuario se guarda en el servidor (POST /preferencias) y se copia aquí
// (localStorage) para la próxima carga. La bitácora de eventos y las exportaciones quedan en español.

(function () {
  function stored(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }

  var tema = stored("argoss.tema", "oscuro");
  var idioma = stored("argoss.idioma", "es");
  if (tema === "claro") document.documentElement.setAttribute("data-theme", "light");
  document.documentElement.lang = idioma === "en" ? "en" : "es";

  var DICT = {
    es: {},
    en: {
      // Cabecera y sesión
      "Planta": "Plant",
      "Usuario: {u}": "User: {u}",
      "Conectados: {l}": "Online: {l}",
      "Conectados: --": "Online: --",
      "Cerrar sesión": "Log out",
      "Configuración": "Settings",
      "Apariencia": "Appearance",
      "Oscuro": "Dark",
      "Claro": "Light",
      "Idioma": "Language",
      "Se guarda en tu usuario. La bitácora de eventos y las descargas se mantienen en español.":
        "Saved to your user. The event log and downloads stay in Spanish.",
      "Recibiendo datos MQTT · último dato: {t}": "Receiving MQTT data · last reading: {t}",
      "Sin datos MQTT · último dato: {t}": "No MQTT data · last reading: {t}",

      // Pestañas y barra superior
      "Totalizadores": "Totals",
      "Silos Matriz": "Matrix Silos",
      "Silos Nitrato": "Nitrate Silos",
      "Silos Nitrato de Amonio": "Ammonium Nitrate Silos",
      "Indicadores": "Indicators",
      "Eventos": "Events",
      "Modo DEMO": "DEMO mode",
      "Modo REAL": "LIVE mode",
      "Fecha:": "Date:",
      "Modo de datos": "Data mode",
      "Descargas": "Downloads",
      "Excel diario Matriz": "Daily Excel · Matrix",
      "Historial 30 días Matriz": "30-day history · Matrix",
      "Excel diario Nitrato": "Daily Excel · Nitrate",
      "Historial 30 días Nitrato": "30-day history · Nitrate",
      "Indicadores · últimos 30 días": "Indicators · last 30 days",
      "Eventos · últimos 3 meses": "Events · last 3 months",

      // Eventos: filtros
      "Desde": "From",
      "Hasta": "To",
      "Severidad": "Severity",
      "Toda severidad": "All severities",
      "Alarma": "Alarm",
      "Aviso": "Warning",
      "Info": "Info",
      "Silo": "Silo",
      "Todos los silos": "All silos",
      "Usuario": "User",
      "Todos los usuarios": "All users",
      "Buscar…": "Search…",
      "Buscar": "Search"
    }
  };

  window.ARGOSS_LANG = idioma === "en" ? "en" : "es";
  window.ARGOSS_LOCALE = window.ARGOSS_LANG === "en" ? "en-US" : "es-CL";

  window.t = function (key, vars) {
    var table = DICT[window.ARGOSS_LANG] || {};
    var text = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
    if (vars) {
      Object.keys(vars).forEach(function (k) { text = text.split("{" + k + "}").join(vars[k]); });
    }
    return text;
  };

  window.applyI18n = function (root) {
    root = root || document;
    root.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
    root.querySelectorAll("[data-i18n-title]").forEach(function (el) { el.title = t(el.getAttribute("data-i18n-title")); });
    root.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) { el.placeholder = t(el.getAttribute("data-i18n-placeholder")); });
    root.querySelectorAll("[data-i18n-aria]").forEach(function (el) { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria"))); });
  };

  window.ARGOSS_DICT = DICT;   // los demás scripts agregan sus textos con Object.assign(ARGOSS_DICT.en, {...})
})();

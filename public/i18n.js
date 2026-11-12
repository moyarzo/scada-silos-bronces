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
      "Buscar": "Search",

      // Totalizadores y tarjetas de silo
      "Hoy": "Today",
      "Ayer": "Yesterday",
      "Sin dato": "No data",
      "Hora": "Time",
      "Ton": "Tons",
      "Totalizador:": "Total:",
      "Modo:": "Mode:",
      "Registro de turno": "Shift record",
      "Inicio turno (07:00)": "Shift start (07:00)",
      "Cierre turno (19:00)": "Shift end (19:00)",
      "Variación turno": "Shift change",
      "Variación (en curso)": "Change (ongoing)",
      "Modo demo: sin registro de turno": "Demo mode: no shift record",
      "Capacidad planta": "Plant capacity",
      "Sin capacidad definida": "No capacity defined",

      // Indicadores
      "Consumo hoy": "Consumption today",
      "Promedio diario": "Daily average",
      "{n} días con datos": "{n} days with data",
      "Consumo 30 días": "Consumption 30 days",
      "Recepciones 30 días": "Receptions 30 days",
      "recarga": "refill",
      "recargas": "refills",
      "consumo y recepciones diarias (t)": "daily consumption and receptions (t)",
      "Consumo": "Consumption",
      "Recepción": "Reception",
      "Sin datos de {x}": "No data for {x}",
      "Consumo 30 d": "Consumption 30 d",
      "Recepción 30 d": "Reception 30 d",
      "Recargas": "Refills",
      "Ruido radar": "Radar noise",
      "Acolpado": "Wall build-up",
      "Acolpado: nitrato pegado a las paredes. Ya está descontado de las toneladas; el nivel y el % muestran la medición física.":
        "Wall build-up: nitrate stuck to the silo walls. Already deducted from the tonnes; level and % show the physical measurement.",
      "Ruido promedio de la lectura del radar (1σ, en toneladas). Un aumento sostenido puede indicar un problema del sensor.":
        "Average noise of the radar reading (1σ, in tonnes). A sustained increase may indicate a sensor problem.",
      "sin datos": "no data",
      "consumo diario por silo (t)": "daily consumption per silo (t)",

      // Eventos
      "Usuarios": "Users",
      "Comunicaciones": "Communications",
      "Proceso": "Process",
      "Operación": "Operation",
      "Todos": "All",
      "Comunicaciones ahora": "Communications now",
      "HMI sin datos": "HMI without data",
      "Broker desconectado": "Broker disconnected",
      "HMI y broker OK": "HMI and broker OK",
      "Silos sin datos ahora": "Silos without data now",
      "Alarmas hoy": "Alarms today",
      "Proceso hoy": "Process today",
      "Accesos hoy": "Logins today",
      "Categoría": "Category",
      "Evento": "Event",
      "Detalle": "Details",
      "Sin eventos para los filtros elegidos": "No events for the selected filters",
      "Mostrando {a} de {b} eventos · se conservan {m} meses": "Showing {a} of {b} events · kept for {m} months",
      "Mostrar más": "Show more"
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

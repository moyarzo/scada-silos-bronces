// ===== NAVEGACIÓN Y SESIÓN (común a Matriz y Nitrato) =====

// Conexión principal: solo para la lista de usuarios conectados.
// Matriz y Nitrato usan sus propias conexiones (/matriz y /nitrato).
const socket = io();

// ===== SUBPÁGINAS =====

const PAGES = ["matriz", "nitrato", "totales"];

function getPageFromHash() {
  const page = (window.location.hash || "").replace("#", "");
  return PAGES.indexOf(page) >= 0 ? page : "matriz";
}

function showPage(page) {
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
  const page = getPageFromHash();
  document.body.dataset.page = page;
  document.querySelectorAll(".page").forEach(function (section) {
    section.hidden = section.dataset.page !== page;
  });
  document.querySelectorAll(".page-tab").forEach(function (tab) {
    tab.classList.toggle("active", tab.dataset.page === page);
    tab.setAttribute("aria-selected", tab.dataset.page === page ? "true" : "false");
  });
})();

// ===== SESIÓN =====

// Quién soy (usa la cookie de sesión ya activa)
fetch("/whoami")
  .then(function (res) { return res.json(); })
  .then(function (data) {
    document.getElementById("currentUser").innerText = "Usuario: " + data.user;
  })
  .catch(function () {});

// Lista de usuarios conectados en tiempo real, emitida por el servidor.
socket.on("connectedUsers", function (users) {
  document.getElementById("connectedUsers").innerText =
    "Conectados: " + users.join(", ");
});

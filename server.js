// El .env se busca siempre en la carpeta del proyecto (no en la carpeta desde donde se ejecuta PM2)
const ENV_FILE = require("path").join(__dirname, ".env");
const envResult = require("dotenv").config({ path: ENV_FILE });

// ===== ARGOSS (Automated Radar Gauging & Online Stock System) — Silos Matriz + Nitrato en un solo servidor =====
// - Login / sesión / usuarios conectados  → este archivo
// - Lógica Silos Matriz                   → lib/matriz.js   (Socket.IO /matriz)
// - Lógica Silos Nitrato                  → lib/nitrato.js  (Socket.IO /nitrato)
// - Frontend                              → public/

const express = require("express");
const http = require("http");
const Server = require("socket.io").Server;
const path = require("path");

// ===== AUTENTICACIÓN =====
const session = require("express-session");
const sharedSession = require("express-socket.io-session");
const bcrypt = require("bcryptjs");

const setupMatriz = require("./lib/matriz");
const { createEventLog } = require("./lib/eventos");
const setupNitrato = require("./lib/nitrato");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const BASE_DIR = __dirname;                       // archivos de datos (.json, template.xlsx, exports/)
const PUBLIC_DIR = path.join(__dirname, "public"); // frontend
const PORT = process.env.PORT || 3000;

// ===== PUBLICACIÓN DETRÁS DE NGINX (HTTPS) =====
// HOST=127.0.0.1      → el puerto 3000 solo es accesible desde la propia VM (Nginx publica 443)
// HTTPS_PROXY_MODE=true → confía en el proxy (X-Forwarded-*) y marca la cookie de sesión como segura
const HOST = process.env.HOST || "0.0.0.0";
const BEHIND_HTTPS_PROXY = String(process.env.HTTPS_PROXY_MODE || "").toLowerCase() === "true";

// ===== MULTIPLANTA (portal argoss.cl) =====
// plantas.json   → lista de plantas que muestra el selector del login (mismo archivo en el portal y en cada planta)
// PLANTA_ID      → planta que atiende ESTE servidor (por defecto "lossauces")
// PORTAL_URL     → portal de selección de planta (ej. https://argoss.cl). Si se define, un login fallido
//                  desde el portal y el "Cerrar sesión" vuelven al portal. Sin definir, todo queda local.
const PLANTA_ID = (process.env.PLANTA_ID || "lossauces").trim();
const PORTAL_URL = (process.env.PORTAL_URL || "").trim().replace(/\/+$/, "");
const PLANTAS_FILE = path.join(__dirname, "plantas.json");

function readPlantas() {
  try {
    var data = JSON.parse(require("fs").readFileSync(PLANTAS_FILE, "utf8"));
    return Array.isArray(data.plantas) ? data.plantas : [];
  } catch (e) {
    return [];
  }
}

// Nombre de la planta de este servidor (cabecera y pestaña del navegador)
function plantaNombre() {
  var p = readPlantas().filter(function (x) { return x.id === PLANTA_ID; })[0];
  return (p && p.nombre) || PLANTA_ID;
}

// ===== VERSIÓN =====
// Número de versión: campo "version" de package.json (se muestra junto a ARGOSS).
// Commit de Git: se muestra al pasar el mouse sobre la versión.
const APP_VERSION = require("./package.json").version;
const APP_COMMIT = (function () {
  try {
    return require("child_process").execSync("git rev-parse --short HEAD", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch (e) { return ""; }
})();

function loginPage(query) {
  // Con portal configurado, el login vuelve al portal; si no, al login local
  return (PORTAL_URL ? PORTAL_URL + "/" : "/login.html") + (query || "");
}

// ===== USUARIOS (login) =====
// Los usuarios y sus hashes bcrypt se definen en el archivo .env
// (ver generate-hash.js para crear los hashes de las contraseñas)

const USERS = {};
for (var u = 1; u <= 5; u++) {
  var userName = (process.env["USER" + u + "_NAME"] || "").trim();
  var userHash = (process.env["USER" + u + "_HASH"] || "").trim().replace(/^["']|["']$/g, "");
  if (userName) USERS[userName] = userHash;
}

// Diagnóstico al arrancar (no muestra contraseñas ni hashes)
if (envResult.error) {
  console.warn("⚠ No se encontró el archivo .env en " + ENV_FILE + " → no hay usuarios para iniciar sesión");
}
if (Object.keys(USERS).length === 0) {
  console.warn("⚠ No hay usuarios configurados (USER1_NAME / USER1_HASH …). Ningún login funcionará.");
} else {
  console.log("Usuarios cargados desde .env: " + Object.keys(USERS).join(", "));
  Object.keys(USERS).forEach(function (name) {
    if (!/^\$2[aby]\$\d{2}\$.{53}$/.test(USERS[name])) {
      console.warn("⚠ El hash del usuario \"" + name + "\" no tiene formato bcrypt válido. Generarlo con: node generate-hash.js \"contraseña\"");
    }
  });
}

async function validateLogin(username, password) {
  var hash = USERS[username];
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect("/login.html");
}

// ===== ROL ADMIN =====
// Solo los usuarios administradores pueden descargar Excel / historial.
// Por defecto el usuario "Admin" (sin distinguir mayúsculas). Se puede cambiar con
// ADMIN_USERS=Admin,otroUsuario en el .env

const ADMIN_USERS = (process.env.ADMIN_USERS || "Admin")
  .split(",")
  .map(function (u) { return u.trim().toLowerCase(); })
  .filter(Boolean);

function isAdmin(username) {
  return !!username && ADMIN_USERS.indexOf(String(username).toLowerCase()) >= 0;
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect("/login.html");
  if (isAdmin(req.session.user)) return next();
  return res.status(403).send("Acceso restringido: solo el usuario administrador puede descargar esta información");
}

// ===== BITÁCORA DE EVENTOS (pestaña Eventos, lib/eventos.js) =====
var eventos = createEventLog({ baseDir: BASE_DIR, isAdmin: isAdmin });

if (BEHIND_HTTPS_PROXY) app.set("trust proxy", 1);   // Nginx entrega HTTPS y reenvía a localhost

var sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "cambia_esta_clave_en_produccion",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
    httpOnly: true,
    secure: BEHIND_HTTPS_PROXY,   // cookie solo por HTTPS cuando se publica detrás de Nginx
    sameSite: "lax"
  }
});

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Usuarios actualmente conectados: socket.id -> username
var connectedUsers = new Map();

function broadcastConnectedUsers() {
  var unique = Array.from(new Set(connectedUsers.values()));
  io.emit("connectedUsers", unique);
}

// ===== RUTAS DE LOGIN (accesibles sin sesión) =====

app.get("/login.html", function (req, res) {
  res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

// Lista de plantas para el selector del login. La planta de este servidor se marca "local"
// para que su login se envíe aquí mismo (funciona también por IP, sin dominio).
app.get("/plantas.json", function (req, res) {
  var plantas = readPlantas().map(function (p) {
    return Object.assign({}, p, { local: p.id === PLANTA_ID });
  });
  if (!plantas.some(function (p) { return p.local; })) {
    plantas.unshift({ id: PLANTA_ID, nombre: PLANTA_ID, url: "", local: true });
  }
  res.json({ plantas: plantas });
});

app.post("/login", async function (req, res) {
  var username = req.body.username;
  var password = req.body.password;
  // El login se envió desde el portal (argoss.cl): un error vuelve al portal con la planta elegida
  var fromPortal = req.body.origen === "portal" && PORTAL_URL;
  var errorUrl = fromPortal ? PORTAL_URL + "/?error=1&planta=" + encodeURIComponent(PLANTA_ID) : "/login.html?error=1";

  try {
    var ok = await validateLogin(username, password);
    var ip = eventos.cleanIp(req.ip);
    if (ok) {
      req.session.user = username;
      req.session.loginAt = Date.now();
      eventos.userLoggedIn(username);
      eventos.log("usuarios", "info", "Inicio de sesión", { usuario: username, ip: ip,
        detalle: "IP " + ip + " · " + eventos.describeAgent(req.get("user-agent")) + (fromPortal ? " · desde argoss.cl" : "") });
      return res.redirect("/");
    }
    var userName = String(username || "").trim().slice(0, 40);
    eventos.log("usuarios", "aviso", "Login fallido", { usuario: userName || "(vacío)", ip: ip,
      detalle: "IP " + ip + " · " + (USERS[userName] ? "contraseña incorrecta" : "usuario inexistente") });
    return res.redirect(errorUrl);
  } catch (error) {
    console.error("Error validando login:", error);
    return res.redirect(errorUrl);
  }
});

app.get("/logout", function (req, res) {
  if (req.session && req.session.user) {
    eventos.userLoggedOut(req.session.user);
    eventos.log("usuarios", "info", "Cierre de sesión", { usuario: req.session.user, ip: eventos.cleanIp(req.ip),
      detalle: req.session.loginAt ? "Duración de la sesión: " + eventos.fmtDuration(Date.now() - req.session.loginAt) : "" });
  }
  req.session.destroy(function () {
    res.redirect(loginPage("?planta=" + encodeURIComponent(PLANTA_ID)));
  });
});

// El propio frontend puede pedir quién está logueado
app.get("/whoami", requireAuth, function (req, res) {
  res.json({
    user: req.session.user,
    isAdmin: isAdmin(req.session.user),
    planta: plantaNombre(),
    version: APP_VERSION,
    commit: APP_COMMIT
  });
});

// ===== SOCKET.IO — sesión compartida en todos los namespaces =====

var matrizNsp  = io.of("/matriz");
var nitratoNsp = io.of("/nitrato");

[io, matrizNsp, nitratoNsp].forEach(function (nsp) {
  nsp.use(sharedSession(sessionMiddleware, { autoSave: true }));
});

// Namespace principal: solo control de usuarios conectados
io.on("connection", function (socket) {
  var username = socket.handshake.session && socket.handshake.session.user;

  // Si no hay sesión válida, se rechaza la conexión del socket
  if (!username) {
    socket.disconnect(true);
    return;
  }

  connectedUsers.set(socket.id, username);
  broadcastConnectedUsers();
  console.log("Usuario conectado por socket:", username);

  // Bitácora: sala según rol (Admin recibe todos los eventos en vivo) y conexión / desconexión
  var ip = eventos.cleanIp(socket.handshake.headers["x-forwarded-for"] || socket.handshake.address);
  eventos.joinRooms(socket, username);
  eventos.socketConnected(username, socket.id, ip);

  // Cambio de modo DEMO / REAL (solo Admin ve el selector)
  socket.on("modoCambiado", function (modo) {
    if (!isAdmin(username) || (modo !== "demo" && modo !== "real")) return;
    eventos.log("usuarios", "info", "Cambio de modo", { usuario: username, ip: ip,
      detalle: modo === "demo" ? "Modo DEMO (datos aleatorios en su navegador)" : "Modo REAL" });
  });

  socket.on("disconnect", function () {
    eventos.socketDisconnected(username, socket.id);
    connectedUsers.delete(socket.id);
    broadcastConnectedUsers();
    console.log("Usuario desconectado:", username);
  });
});

// ===== SISTEMAS =====

// Descargas de Excel / CSV (solo Admin): se registran en la bitácora
var DOWNLOAD_NAMES = {
  "/matriz/export-data": "Excel diario Matriz", "/export-data": "Excel diario Matriz",
  "/matriz/export-daily-summary": "Historial 30 días Matriz", "/export-daily-summary": "Historial 30 días Matriz",
  "/nitrato/export-data": "Excel diario Nitrato", "/nitrato/export-daily-summary": "Historial 30 días Nitrato"
};
app.use(function (req, res, next) {
  var name = DOWNLOAD_NAMES[req.path];
  if (name && req.method === "GET" && req.session && isAdmin(req.session.user)) {
    eventos.log("usuarios", "info", "Descarga", { usuario: req.session.user, ip: eventos.cleanIp(req.ip), detalle: name });
  }
  next();
});

setupMatriz({ app: app, io: matrizNsp, requireAuth: requireAuth, requireAdmin: requireAdmin, baseDir: BASE_DIR, eventos: eventos });
setupNitrato({ app: app, io: nitratoNsp, requireAuth: requireAuth, requireAdmin: requireAdmin, baseDir: BASE_DIR, eventos: eventos });

eventos.attachSocket(io);
eventos.setupRoutes(app, requireAuth, requireAdmin);

// login.html queda servido por la ruta /login.html de arriba.
// Todo lo demás (dashboard, JS, CSS del panel) requiere sesión activa.
app.use("/", requireAuth, express.static(PUBLIC_DIR));

server.listen(PORT, HOST, function () {
  eventos.start();
  console.log("ARGOSS v" + APP_VERSION + (APP_COMMIT ? " (" + APP_COMMIT + ")" : "") + " — " + plantaNombre() + " — corriendo en puerto " + PORT);
});

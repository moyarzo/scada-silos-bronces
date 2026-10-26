require("dotenv").config();

// ===== SCADA SILOS LB — Matriz + Nitrato en un solo servidor =====
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
const setupNitrato = require("./lib/nitrato");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const BASE_DIR = __dirname;                       // archivos de datos (.json, template.xlsx, exports/)
const PUBLIC_DIR = path.join(__dirname, "public"); // frontend
const PORT = process.env.PORT || 3000;

// ===== USUARIOS (login) =====
// Los usuarios y sus hashes bcrypt se definen en el archivo .env
// (ver generate-hash.js para crear los hashes de las contraseñas)

const USERS = {};
if (process.env.USER1_NAME) USERS[process.env.USER1_NAME] = process.env.USER1_HASH;
if (process.env.USER2_NAME) USERS[process.env.USER2_NAME] = process.env.USER2_HASH;
if (process.env.USER3_NAME) USERS[process.env.USER3_NAME] = process.env.USER3_HASH;
if (process.env.USER4_NAME) USERS[process.env.USER4_NAME] = process.env.USER4_HASH;
if (process.env.USER5_NAME) USERS[process.env.USER5_NAME] = process.env.USER5_HASH;

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

var sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "cambia_esta_clave_en_produccion",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
    httpOnly: true
    // secure: true  // <- descomentar cuando el sitio corra bajo HTTPS
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

app.post("/login", async function (req, res) {
  var username = req.body.username;
  var password = req.body.password;

  try {
    var ok = await validateLogin(username, password);
    if (ok) {
      req.session.user = username;
      return res.redirect("/");
    }
    return res.redirect("/login.html?error=1");
  } catch (error) {
    console.error("Error validando login:", error);
    return res.redirect("/login.html?error=1");
  }
});

app.get("/logout", function (req, res) {
  req.session.destroy(function () {
    res.redirect("/login.html");
  });
});

// El propio frontend puede pedir quién está logueado
app.get("/whoami", requireAuth, function (req, res) {
  res.json({ user: req.session.user, isAdmin: isAdmin(req.session.user) });
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

  socket.on("disconnect", function () {
    connectedUsers.delete(socket.id);
    broadcastConnectedUsers();
    console.log("Usuario desconectado:", username);
  });
});

// ===== SISTEMAS =====

setupMatriz({ app: app, io: matrizNsp, requireAuth: requireAuth, requireAdmin: requireAdmin, baseDir: BASE_DIR });
setupNitrato({ app: app, io: nitratoNsp, requireAuth: requireAuth, requireAdmin: requireAdmin, baseDir: BASE_DIR });

// login.html queda servido por la ruta /login.html de arriba.
// Todo lo demás (dashboard, JS, CSS del panel) requiere sesión activa.
app.use("/", requireAuth, express.static(PUBLIC_DIR));

server.listen(PORT, "0.0.0.0", function () {
  console.log("Servidor SCADA Silos (Matriz + Nitrato) corriendo en puerto " + PORT);
});

# SCADA-LB — Silos Matriz + Nitrato de Amonio

SCADA-LB is a project developed to visualize bulk product level data in industrial storage silos. Radar sensors installed in each silo were used to measure the level, communicating via the Modbus protocol with an HMI screen. The HMI screen is capable of publishing messages to an MQTT broker. The developed dashboard displays operational data from the silos, such as mass calculations, consumption records, alarms, among others, and also allows changing the product in the silos.

Desde la versión 2.0 el proyecto integra en **un solo servidor y una sola página web** los dos sistemas que antes corrían por separado:

- **Silos Matriz** (8 silos · DL-5 / VE-03 / ASE) — ex `scada-matriz`
- **Silos Nitrato de Amonio** (8 silos) — ex `scada-nitrato`

<img width="1912" height="881" alt="image" src="https://github.com/user-attachments/assets/17e989af-3a72-4fb1-befe-880ae4728f3d" />

---

## Subpáginas

La página tiene 3 pestañas seleccionables por el usuario (la pestaña activa queda en la URL: `/#matriz`, `/#nitrato`, `/#totales`):

| Pestaña            | Contenido                                                                 |
|--------------------|---------------------------------------------------------------------------|
| **Silos Matriz**   | 8 tarjetas de silos Matriz (nivel, volumen, masa, %, gauge, mini-gráfico de % llenado, selector de producto en modo demo) |
| **Silos Nitrato**  | 8 tarjetas de silos Nitrato (mismos datos; `≈` cuando el nivel está en zona de tolva y es aproximado) |
| **Totalizadores**  | Gráficos de tendencia diaria 07:00–19:00 de DL-5, ASE (y VE-03 si hay un silo con ese producto) y Nitrato, con su cuadro de totalizador y registro de turno 07h / 19h |

La barra superior es común: modo DEMO / REAL (aplica a ambos sistemas), un único estado de señal MQTT (Matriz y Nitrato comparten HMI/broker; se marca activo con el último dato recibido de cualquiera de los dos) y selector de día de los gráficos.

**Descargas (Excel diario / historial 30 días): solo usuario `Admin`.** Los demás usuarios no ven los botones y el servidor responde 403 si intentan acceder a las rutas de descarga. Para Admin, los botones se muestran según la pestaña: Matriz, Nitrato o los 4 en Totalizadores. Los administradores se definen con `ADMIN_USERS` en el `.env` (por defecto `Admin`, sin distinguir mayúsculas).

---

## Funciones (se mantienen todas las de ambos proyectos)

- Login con usuarios del `.env` (bcrypt), sesión de 8 h, usuario actual y usuarios conectados en tiempo real
- Visualización en tiempo real de nivel, volumen, masa (ton) y % por silo
- Alertas visuales de nivel alto (≥85 % warning, ≥90 % crítico)
- Gráfico de tendencia diaria del totalizador por producto, con marcadores ▲/▼ y zoom
- Mini-gráfico de % de llenado por silo
- Registro de turno (07h inicio / 19h cierre) y resumen diario automático a las 19:00
- Historial de 30 días navegable por fecha
- Modo REAL / DEMO
- Cambio de producto por silo (Matriz)
- Exportación Excel diario y CSV historial 30 días, por sistema (solo usuario Admin)

---

## Cálculo de nivel

**Matriz** — `nivel = 5.92 − distancia_radar × 0.98`, volumen cono + cilindro (46.168 m³).

**Nitrato** — tabla empírica radar → nivel (`RADAR_TABLE` en `lib/nitrato.js`), registrada en terreno con LiDAR en junio 2026. El LiDAR solo se usó para levantar la tabla; en operación se usa únicamente el radar.

| Lectura radar   | Cálculo de nivel                                                   |
|-----------------|--------------------------------------------------------------------|
| 0.34 – 4.05 m   | Interpolación lineal sobre la tabla (zona recta)                   |
| 4.05 – 7.05 m   | Aproximado: interpolación hasta el punto de silo vacío (tolva). Se muestra con `≈` |
| ≥ 7.05 m        | Silo vacío (0.70 m³ residuales)                                    |

Volumen con tolva de pirámide truncada (2.78 → 3.48 m, 0.78 m) + prisma 3.48 × 3.48 × 5.95 m = 79.73 m³; densidad 750 kg/m³; % de llenado volumétrico.

---

## MQTT — Topics

Payload Delta HMI con word-swap: `{ "d": { "tipo": 12345678 } }` (uint32 → float = distancia del radar en metros).

| Sistema  | Topics                                        | Silo                    |
|----------|-----------------------------------------------|-------------------------|
| Matriz   | `planta/losbronces/silos/tanque1` … `tanque8` | Silo 1 … Silo 8         |
| Nitrato  | `silo11` … `silo18`                           | Silo 1 … Silo 8 Nitrato |

Nitrato identifica el silo por el último segmento del topic, así que acepta `silo11` solo o con prefijo (`planta/losbronces/silos/silo11`, `planta/losbronces/nitrato/silo11`). Por defecto se suscribe a esas tres variantes; para fijar otras, usar `MQTT_TOPIC_NITRATO` (separadas por coma).

Por defecto ambos sistemas se conectan a `mqtt://localhost:1883`. Si el HMI de Nitrato publica en otro broker, definir `MQTT_URL_NITRATO` en el `.env` (ver `env.example`).

---

## Instalación

Requisitos: [Node.js](https://nodejs.org/) ≥ 18, [npm](http://npmjs.com/), [Git](https://git-scm.com/downloads), [Eclipse Mosquitto](https://mosquitto.org/), [PM2](https://pm2.keymetrics.io/).

```sh
git clone https://github.com/moyarzo/scada-matriz.git
cd scada-matriz
npm install
cp env.example .env          # completar SESSION_SECRET y usuarios
node generate-hash.js "contraseña"   # genera el hash para USERx_HASH
```

### Ejecución

```sh
# Desarrollo
node server.js

# Producción
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

> [!IMPORTANT]
> Acceder en http://localhost:3000/

### Migrar datos del servidor Nitrato anterior

Los datos de Matriz conservan sus nombres originales. Los de Nitrato usan prefijo `nitrato_`. Para conservar el historial de la VM de Nitrato, copiar sus archivos renombrándolos:

```sh
cp ../scada-nitrato/turnData.json        nitrato_turnData.json
cp ../scada-nitrato/historyData.json     nitrato_historyData.json
cp ../scada-nitrato/siloHistoryData.json nitrato_siloHistoryData.json
cp ../scada-nitrato/dailySummary.json    nitrato_dailySummary.json
```

---

## Estructura del proyecto

```
scada-matriz/
├── server.js             ← Express + login/sesión + Socket.IO (usuarios conectados)
├── lib/
│   ├── utils.js          ← Funciones comunes (fechas, JSON, decodificación Delta)
│   ├── matriz.js         ← Backend Silos Matriz   (Socket.IO /matriz,  rutas /matriz/*)
│   └── nitrato.js        ← Backend Silos Nitrato  (Socket.IO /nitrato, rutas /nitrato/*)
├── public/
│   ├── index.html        ← Página con las 3 pestañas
│   ├── login.html
│   ├── main.js           ← Pestañas, usuario actual, usuarios conectados
│   ├── matriz.js         ← Frontend Silos Matriz
│   ├── nitrato.js        ← Frontend Silos Nitrato
│   ├── styles.css
│   └── logo.png
├── template.xlsx         ← Plantilla Excel diario (ambos sistemas)
├── siloConfig.json       ← Producto por silo (Matriz)
├── generate-hash.js
├── ecosystem.config.js   ← PM2
├── env.example
└── package.json
```

### Archivos de datos (generados en runtime)

| Matriz                 | Nitrato                         | Contenido                                     |
|------------------------|---------------------------------|-----------------------------------------------|
| `turnData.json`        | `nitrato_turnData.json`         | Registro de turno 07h/19h por día             |
| `historyData.json`     | `nitrato_historyData.json`      | Historial del totalizador cada 5 min (30 días) |
| `siloHistoryData.json` | `nitrato_siloHistoryData.json`  | Historial de % llenado por silo cada 5 min    |
| `dailySummary.json`    | `nitrato_dailySummary.json`     | Resumen diario guardado a las 19:00           |
| `exports/stock_diario_YYYYMMDD.xlsx` | `exports/stock_nitrato_YYYYMMDD.xlsx` | Excel diario |
| `historial_YYYYMMDD.csv` | `resumen_nitrato_YYYYMMDD.csv` | CSV historial 30 días                        |

### Rutas HTTP

Todas las rutas de descarga requieren usuario Admin.

| Matriz                          | Nitrato                          |
|---------------------------------|----------------------------------|
| `/matriz/export-data`           | `/nitrato/export-data`           |
| `/matriz/export-daily-summary`  | `/nitrato/export-daily-summary`  |
| `/matriz/export-trend`          | `/nitrato/export-trend`          |

Las rutas antiguas `/export-data`, `/export-daily-summary` y `/export-trend` siguen funcionando para Matriz.

---

## Testing

The dashboard includes a switch for demo mode and another for live mode. In demo mode, you can test the functions with random data. In live mode, it reads data from the MQTT broker.

---

## Licencia

MIT © 2026 MOH — marco.oyarzo@enaex.com

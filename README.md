# SCADA-LB — Bulk Silo Monitoring (Matriz + Ammonium Nitrate)

SCADA-LB is a real-time monitoring system for bulk product storage silos at the Los Bronces plant. A radar level sensor installed in each silo measures the distance to the product surface and communicates over Modbus with a Delta HMI, which publishes the readings to an MQTT broker. The web dashboard turns those readings into level, volume, mass and fill percentage per silo, plant totals per product, shift records, alarms, 30-day history and consumption indicators.

One server and one web page monitor two silo systems:

- **Matriz silos** — 8 silos · products DL-5 / VE-03 / ASE
- **Ammonium nitrate silos** — 8 silos

![SCADA-LB walkthrough with simulated data](docs/demo.gif)

*Walkthrough with simulated plant data: live MQTT readings (consumption and a silo being refilled up to the high-level alarm) and 30 days of generated history.*

---

## Features

- Real-time level, volume, mass (t) and fill % for 16 silos, updated on every MQTT message
- High-level alarms (≥ 85 % warning, ≥ 90 % critical)
- Daily trend chart (07:00–19:00) of the plant total per product, with ▲/▼ change markers and zoom
- Per-silo mini chart of fill %
- Shift record (07:00 start / 19:00 close) and an automatic daily summary saved at 19:00
- 30-day history, browsable by date
- Plant capacity gauge per product
- **Indicators** page: daily consumption, receptions and per-silo usage over 30 days, with a radar-noise filter
- Login with bcrypt-hashed users, 8 h sessions, live list of connected users
- Role-based access: downloads, DEMO mode and Indicators are visible only to the `Admin` user
- Daily Excel report and 30-day CSV export per system (Admin only)
- REAL / DEMO modes (DEMO generates random data in the browser)
- Product assignment per Matriz silo

---

## Pages

The page has four tabs. The SCADA opens on **Totalizadores**, and the active tab is kept in the URL (`/#totales`, `/#matriz`, `/#nitrato`, `/#kpi`). The user interface is in Spanish.

| Tab | Content |
|---|---|
| **Totalizadores** (plant totals) | Daily trend charts 07:00–19:00 for DL-5, ASE (and VE-03 when a silo holds it) and Nitrate. Under each chart: shift-record table (07:00 start, 19:00 close, variation) and a plant-capacity gauge |
| **Silos Matriz** | 8 silo cards: level, volume, mass, %, gauge, fill-% mini chart, product selector (DEMO mode) |
| **Silos Nitrato** | 8 silo cards with the same data; `≈` marks levels in the hopper zone, where the value is approximate |
| **Indicadores** (Admin only) | Last 30 days from history: per product, today's consumption, daily average, 30-day consumption and receptions with number of refills; daily consumption vs. reception chart; per-silo daily consumption table with totals and measured radar noise |

The top bar is shared by all tabs: REAL/DEMO selector (Admin only; other users always see REAL), a single MQTT signal indicator (both systems share the HMI and broker; it turns green with the latest reading from either), the chart-date selector and the download buttons (Admin only, shown according to the active tab).

**Plant capacity** (gauge in Totalizadores): DL-5 420 t, ASE 37 t, Nitrate 480 t. Change it in `PRODUCT_CAPACITY` in `public/matriz.js` and `public/nitrato.js` (VE-03 has no capacity defined).

---

## Level and mass calculation

### Matriz

`level = 5.92 − radar_distance × 0.98`. Volume is a cone + cylinder (46.168 m³). Densities: DL-5 1300 kg/m³, VE-03 1370 kg/m³, ASE 800 kg/m³.

### Ammonium nitrate

The geometry and formulas match the plant's conventional spreadsheet (*Cálculo de MMPP en Silos*):

| Section | Geometry | Volume |
|---|---|---|
| Column | 3.48 × 3.48 m, height 5.95 m | 72.06 m³ |
| Intermediate hopper | truncated pyramid 3.48 → 2.78 m, height 0.78 m | 7.67 m³ |
| Final hoppers | 2 × truncated pyramid 1.39 × 2.78 → 0.32 × 0.38 m, height 1.16 m | 3.61 m³ |
| **Total** | height 7.89 m (level measured from the bottom of the final hoppers) | **83.34 m³** |

Density is 750 kg/m³, the same as the spreadsheet (`NITRATO_DENSIDAD`). Fill % is volumetric.

**Radar calibration.** At startup, a straight line `distance = A·radar + B` is fitted by least squares to the field points in `RADAR_CALIBRATION` (`lib/nitrato-model.js`): LiDAR measurements from June 2026 and manual tape measurements from November 2026. All points are referenced like the spreadsheet (measurement − 0.09 m hatch height). Current fit: `1.039·radar − 0.072`, error < 9 cm. To recalibrate, add rows and restart; the startup log prints the resulting line.

| Real distance | Level |
|---|---|
| ≤ 5.95 m | Column: level = 7.89 − distance |
| 5.95 – 6.73 m | Intermediate hopper: level = 7.89 − distance (shown with `≈`) |
| 6.73 m – empty reading | Final hoppers, approximated down to the empty-silo level (`≈`) |
| radar ≥ 7.05 m | Empty silo: residual mass `NITRATO_MASA_VACIO_TON` (0.10 t) |

The radar cannot see the bottom of the two final hoppers (an empty silo reads about 7.05 m), so that zone is approximate.

The nitrate model lives in `lib/nitrato-model.js` and is shared by the server and the history recalculation tool, so both always compute the same way.

### Recalculating history after a model change

History stores computed values (tonnes and %). When the calculation model changes, older points keep the old model and the chart shows a step. `tools/recalcular-historial-nitrato.js` rebuilds the original radar reading from each stored % and recomputes every point with the current model (per silo, plant total and shift record), with an automatic backup in `backups/`:

```sh
pm2 stop scada-silos
node tools/recalcular-historial-nitrato.js              # dry run: shows the changes
node tools/recalcular-historial-nitrato.js --aplicar    # apply (--dias N or --todo for earlier days)
pm2 start scada-silos
```

The switch-over time is read from the PM2 log. If it is not found, pass it with `--corte "YYYY-MM-DD HH:MM"`. Converted days are recorded in `nitrato_recalculo.json` and are never converted twice.

---

## Indicators (`lib/kpi.js`)

Indicators are computed per silo from the fill % stored every 5 minutes, converted to tonnes with each system's model. Decreases count as consumption and increases as reception.

- **Radar-noise filter:** 35-minute moving median, then hysteresis with an adaptive threshold per silo and per day (3σ of the measured noise, minimum `KPI_UMBRAL_TON` = 0.3 t). In simulation it keeps the error below 1.5 % with noise up to ±6 cm and spurious spikes.
- **Refill:** a continuous run of increases totalling at least `KPI_RECARGA_MIN_TON` (1 t).
- A stored value of exactly 0 % is treated as "no data".
- Matriz silos use their current product assignment.
- The **Radar noise** column (1σ, in tonnes) helps detect a sensor that needs attention.

---

## MQTT

Delta HMI payload with word swap: `{ "d": { "tipo": 12345678 } }` (uint32 → float = radar distance in metres).

| System | Topics | Silo |
|---|---|---|
| Matriz | `planta/losbronces/silos/tanque1` … `tanque8` | Silo 1 … Silo 8 |
| Nitrate | `planta/losbronces/silos/tanque11` … `tanque18` | Nitrate silo 1 … silo 8 |

Both systems use the same HMI and topic prefix. Nitrate identifies the silo from the last topic segment and also accepts `silo11` … `silo18` as aliases. Both connect to `mqtt://localhost:1883` by default (see the configuration table below).

---

## Installation

Requirements: [Node.js](https://nodejs.org/) ≥ 18, [npm](https://www.npmjs.com/), [Git](https://git-scm.com/downloads), [Eclipse Mosquitto](https://mosquitto.org/), [PM2](https://pm2.keymetrics.io/).

```sh
git clone https://github.com/moyarzo/scada-silos-bronces.git
cd scada-silos-bronces
npm install
```

Create the `.env` file with the users (see `env.example` for every option). Each password is stored only as a bcrypt hash:

```sh
echo "SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" > .env
echo "USER1_NAME=Admin" >> .env
echo "USER1_HASH=$(node generate-hash.js 'AdminPassword')" >> .env
echo "USER2_NAME=operator1" >> .env
echo "USER2_HASH=$(node generate-hash.js 'OperatorPassword')" >> .env
```

Set the server to the plant's time zone. Shifts, the 19:00 summary and chart labels use the server clock:

```sh
sudo timedatectl set-timezone America/Santiago
```

### Running

```sh
# Development
node server.js

# Production
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

> [!IMPORTANT]
> Open http://localhost:3000/

On startup the log lists the loaded users and the nitrate calibration. If the `.env` file is missing or a hash is malformed, a warning is printed.

### Updating without losing history

Data files are not touched by updates, so `git pull` followed by `pm2 restart scada-silos` keeps all history. Do not run `git reset --hard` or `git checkout .` on the server: they can revert `historyData.json` and `turnData.json`.

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | — | Session signing secret (required) |
| `USER1_NAME` … `USER5_NAME` / `USER1_HASH` … `USER5_HASH` | — | Users and bcrypt hashes (`node generate-hash.js 'password'`) |
| `ADMIN_USERS` | `Admin` | Comma-separated administrator users (case-insensitive) |
| `PORT` | `3000` | HTTP port |
| `MQTT_URL` | `mqtt://localhost:1883` | Broker for both systems |
| `MQTT_URL_MATRIZ` / `MQTT_URL_NITRATO` | `MQTT_URL` | Per-system broker override |
| `MQTT_TOPIC_MATRIZ` | `planta/losbronces/silos/#` | Matriz subscription |
| `MQTT_TOPIC_NITRATO` | `planta/losbronces/silos/#` | Nitrate subscriptions (comma-separated) |
| `NITRATO_DENSIDAD` | `750` | Nitrate density (kg/m³) |
| `NITRATO_MASA_VACIO_TON` | `0.10` | Residual mass shown for an empty nitrate silo (t) |
| `KPI_UMBRAL_TON` | `0.3` | Minimum noise threshold for indicators (t) |
| `KPI_RECARGA_MIN_TON` | `1` | Minimum mass to count a refill (t) |

---

## Users and roles

| Feature | Admin | Other users |
|---|---|---|
| Totalizadores, Silos Matriz, Silos Nitrato | ✔ | ✔ |
| Indicadores tab | ✔ | — |
| REAL / DEMO selector | ✔ | — (always REAL) |
| Excel / CSV downloads | ✔ | — |

Restrictions are enforced on the server too: download and indicator routes return HTTP 403 for non-admin users.

---

## Project structure

```
scada-silos-bronces/
├── server.js                 ← Express, login/session, Socket.IO (connected users)
├── lib/
│   ├── utils.js              ← Shared helpers (dates, JSON, Delta decoding)
│   ├── matriz.js             ← Matriz backend   (Socket.IO /matriz,  routes /matriz/*)
│   ├── nitrato.js            ← Nitrate backend  (Socket.IO /nitrato, routes /nitrato/*)
│   ├── nitrato-model.js      ← Nitrate geometry, radar calibration, level and volume
│   └── kpi.js                ← Consumption / reception / per-silo indicators
├── tools/
│   └── recalcular-historial-nitrato.js   ← Recalculate nitrate history after a model change
├── public/
│   ├── index.html            ← Dashboard with the four tabs
│   ├── login.html
│   ├── main.js               ← Tabs, session, roles, shared MQTT status, shift table and capacity gauge
│   ├── matriz.js             ← Matriz frontend
│   ├── nitrato.js            ← Nitrate frontend
│   ├── kpi.js                ← Indicators tab
│   ├── styles.css
│   └── logo.png
├── docs/demo.gif             ← README walkthrough
├── template.xlsx             ← Daily Excel template (both systems)
├── siloConfig.json           ← Product per Matriz silo
├── generate-hash.js          ← bcrypt hash generator for user passwords
├── ecosystem.config.js       ← PM2
├── env.example
└── package.json
```

### Data files (created at runtime)

| Matriz | Nitrate | Content |
|---|---|---|
| `turnData.json` | `nitrato_turnData.json` | Shift record 07:00 / 19:00 per day |
| `historyData.json` | `nitrato_historyData.json` | Plant total every 5 min (30 days) |
| `siloHistoryData.json` | `nitrato_siloHistoryData.json` | Fill % per silo every 5 min |
| `dailySummary.json` | `nitrato_dailySummary.json` | Daily summary saved at 19:00 |
| `exports/stock_diario_YYYYMMDD.xlsx` | `exports/stock_nitrato_YYYYMMDD.xlsx` | Daily Excel report |
| `historial_YYYYMMDD.csv` | `resumen_nitrato_YYYYMMDD.csv` | 30-day CSV export |

### HTTP routes

| Matriz | Nitrate | Access |
|---|---|---|
| `/matriz/export-data` | `/nitrato/export-data` | Admin |
| `/matriz/export-daily-summary` | `/nitrato/export-daily-summary` | Admin |
| `/matriz/export-trend` | `/nitrato/export-trend` | Admin |
| `/matriz/kpi` | `/nitrato/kpi` | Admin |

The legacy routes `/export-data`, `/export-daily-summary` and `/export-trend` still work for Matriz.

---

## Testing

An Admin user can switch to **DEMO** mode, which generates random silo data in the browser to exercise the interface without MQTT. In **REAL** mode the dashboard shows the data received from the MQTT broker.

---

## License

MIT © 2026 Marco Oyarzo — see [LICENSE](LICENSE).

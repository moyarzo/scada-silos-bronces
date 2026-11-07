# ARGOS — Automated Radar Gauging & Online Stock

**Bulk silo monitoring for Matriz and ammonium nitrate · Los Bronces plant**

ARGOS is a real-time monitoring system for bulk product storage silos at the Los Bronces plant. A radar level sensor installed in each silo measures the distance to the product surface and communicates over Modbus with a Delta HMI, which publishes the readings to an MQTT broker. The web dashboard turns those readings into level, volume, mass and fill percentage per silo, plant totals per product, shift records, alarms, 30-day history and consumption indicators.

The name comes from Argos Panoptes, the hundred-eyed giant of Greek mythology who never stopped watching — like the radars that keep every silo under constant observation.

One server and one web page monitor two silo systems:

- **Matriz silos** — 8 silos · products DL-5 / VE-03 / ASE
- **Ammonium nitrate silos** — 8 silos

![ARGOS walkthrough with simulated data](docs/demo.gif)

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
- Role-based access: downloads and DEMO mode are visible only to the `Admin` user
- Daily Excel report and 30-day CSV export per system (Admin only)
- REAL / DEMO modes (DEMO generates random data in the browser)
- Product assignment per Matriz silo

---

## Pages

The page has four tabs. ARGOS opens on **Totalizadores**, and the active tab is kept in the URL (`/#totales`, `/#matriz`, `/#nitrato`, `/#kpi`). The user interface is in Spanish.

| Tab | Content |
|---|---|
| **Totalizadores** (plant totals) | Daily trend charts 07:00–19:00 for DL-5, ASE (and VE-03 when a silo holds it) and Nitrate. Under each chart: shift-record table (07:00 start, 19:00 close, variation) and a plant-capacity gauge |
| **Silos Matriz** | 8 silo cards: level, volume, mass, %, gauge, fill-% mini chart, product selector (DEMO mode) |
| **Silos Nitrato** | 8 silo cards with the same data; `≈` marks levels in the hopper zone, where the value is approximate |
| **Indicadores** (indicators) | Last 30 days from history: per product, today's consumption, daily average, 30-day consumption and receptions with number of refills; daily consumption vs. reception chart; per-silo daily consumption table with totals, refills, discarded jumps (power cuts) and measured radar noise |

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

- **Radar-noise filter:** 35-minute moving median, then hysteresis with an adaptive threshold per silo and per day (3σ of the measured noise, minimum `KPI_UMBRAL_TON` = 0.3 t). In 30-day simulations the consumption and reception error stays below 3 % with radar noise up to ±6 cm plus spurious spikes.
- **Refill:** a *gradual* rise of more than `KPI_RECARGA_MIN_TON` (2 t) — the level increases over at least `KPI_RECARGA_MIN_PASOS` (3) consecutive filter steps, i.e. ≥ 15 min rising. Any other rise (sudden, or under 2 t) is neither a refill nor a reception. If the level falls back afterwards (oscillation) or the rise was under 2 t (radar drift), the reference returns to the previous level so the later fall is not counted as consumption either. A sudden rise ≥ 2 t that persists (e.g. a refill made entirely during an outage) becomes the new reference level.
- **Jumps (power cuts, sensor/HMI restarts):** if the fill % changes more than `KPI_SALTO_PCT` (10 points) per 5 minutes elapsed between two valid readings, the series is cut there and the jump is not counted as consumption or reception. If the level later returns close to its previous value, the false readings in between are discarded and both sides are joined, so real consumption during the outage is still counted. A real refill already in progress continues to count across a power cut. A refill that happens entirely while the system has no data is not counted as a refill or reception; the new level simply becomes the reference.
- Readings of exactly 0 % or ≥ 99.5 % (a radar restarting reports distance 0; the product never reaches the antenna) are treated as "no data".
- The **Saltos** column shows how many jumps were discarded per silo in 30 days.
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

### Publishing with a domain and HTTPS

1. Point a DNS **A record** for your domain (e.g. `argos.example.com`) to the VM's static IP.
2. Open ports **80** and **443** in the cloud firewall.
3. Install Nginx and Certbot: `sudo apt install nginx certbot python3-certbot-nginx`
4. Create `/etc/nginx/sites-available/argos` (WebSocket headers are required by Socket.IO):

   ```nginx
   server {
       listen 80;
       server_name argos.example.com;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_read_timeout 86400;
       }
   }
   ```

5. Enable it and get the certificate (Certbot adds HTTPS, the HTTP → HTTPS redirect and automatic renewal):

   ```sh
   sudo ln -s /etc/nginx/sites-available/argos /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d argos.example.com
   ```

6. Add `HOST=127.0.0.1` and `HTTPS_PROXY_MODE=true` to `.env`, run `pm2 restart scada-silos`, and close port 3000 in the firewall.

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
| `HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` behind Nginx so port 3000 is not exposed |
| `HTTPS_PROXY_MODE` | `false` | `true` behind an HTTPS reverse proxy: trusts `X-Forwarded-*` and sends the session cookie only over HTTPS |
| `MQTT_URL` | `mqtt://localhost:1883` | Broker for both systems |
| `MQTT_URL_MATRIZ` / `MQTT_URL_NITRATO` | `MQTT_URL` | Per-system broker override |
| `MQTT_TOPIC_MATRIZ` | `planta/losbronces/silos/#` | Matriz subscription |
| `MQTT_TOPIC_NITRATO` | `planta/losbronces/silos/#` | Nitrate subscriptions (comma-separated) |
| `NITRATO_DENSIDAD` | `750` | Nitrate density (kg/m³) |
| `NITRATO_MASA_VACIO_TON` | `0.10` | Residual mass shown for an empty nitrate silo (t) |
| `KPI_UMBRAL_TON` | `0.3` | Minimum noise threshold for indicators (t) |
| `KPI_RECARGA_MIN_TON` | `2` | Minimum mass to count a refill (t) |
| `KPI_RECARGA_MIN_PASOS` | `3` | Minimum consecutive rising steps for a gradual refill |
| `KPI_SALTO_PCT` | `10` | Maximum credible change in fill % per 5 min; larger changes are jumps |

---

## Users and roles

| Feature | Admin | Other users |
|---|---|---|
| Totalizadores, Silos Matriz, Silos Nitrato | ✔ | ✔ |
| Indicadores tab | ✔ | ✔ |
| REAL / DEMO selector | ✔ | — (always REAL) |
| Excel / CSV downloads | ✔ | — |

Restrictions are enforced on the server too: download routes return HTTP 403 for non-admin users.

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
| `/matriz/kpi` | `/nitrato/kpi` | Any logged-in user |

The legacy routes `/export-data`, `/export-daily-summary` and `/export-trend` still work for Matriz.

---

## Testing

An Admin user can switch to **DEMO** mode, which generates random silo data in the browser to exercise the interface without MQTT. In **REAL** mode the dashboard shows the data received from the MQTT broker.

---

## License

MIT © 2026 Marco Oyarzo — see [LICENSE](LICENSE).

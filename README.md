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
| **Totalizadores**  | Gráficos de tendencia diaria 07:00–19:00 de DL-5, ASE (y VE-03 si hay un silo con ese producto) y Nitrato. Bajo cada gráfico: tabla de registro de turno (inicio 07h, cierre 19h, variación) y gauge de % de capacidad de planta |
| **KPI** (solo Admin) | Últimos 30 días (desde el historial): por producto, consumo de hoy, promedio diario, consumo y recepciones de 30 días con n.º de recargas; gráfico diario de consumo y recepción; tabla de consumo diario por silo con totales y ruido medido del radar |

La barra superior es común: modo DEMO / REAL (aplica a ambos sistemas; **solo visible para Admin**, los demás usuarios siempre ven modo REAL), un único estado de señal MQTT (Matriz y Nitrato comparten HMI/broker; se marca activo con el último dato recibido de cualquiera de los dos) y selector de día de los gráficos.

**Cálculo de KPI (`lib/kpi.js`).** Se calcula por silo desde el % guardado cada 5 min, convertido a toneladas con el modelo de cada sistema. Bajas = consumo, subidas = recepción. Filtro de ruido del radar: mediana móvil de 35 min + umbral adaptativo por silo y día (3σ del ruido medido, mínimo `KPI_UMBRAL_TON` = 0.3 t). Validado por simulación: error < 1.5 % con ruido de hasta ±6 cm y picos. Una recarga es un tramo de subidas ≥ `KPI_RECARGA_MIN_TON` (1 t). Un % exactamente 0 se considera "sin dato". El producto de cada silo de Matriz es el de la configuración actual.

**Capacidad de planta (gauge en Totalizadores):** DL-5 420 t, ASE 37 t, Nitrato 480 t. Se cambian en `PRODUCT_CAPACITY` de `public/matriz.js` y `public/nitrato.js` (VE-03 sin capacidad definida).

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

**Nitrato** — mismo modelo que la planilla *Cálculo de MMPP en Silos*:

| Sección            | Geometría                                                    | Volumen   |
|--------------------|--------------------------------------------------------------|-----------|
| Columna            | 3.48 × 3.48 m, alto 5.95 m                                   | 72.06 m³  |
| Embudo intermedio  | pirámide truncada 3.48 → 2.78 m, alto 0.78 m                 | 7.67 m³   |
| Embudos finales    | 2 × pirámide truncada 1.39 × 2.78 → 0.32 × 0.38 m, alto 1.16 m | 3.61 m³ |
| **Total**          | alto 7.89 m (nivel medido desde el fondo de los embudos)     | **83.34 m³** |

Densidad 750 kg/m³ (como la planilla; ajustable con `NITRATO_DENSIDAD`). % de llenado volumétrico.

**Radar → distancia real.** Recta `distancia = A·radar + B` ajustada al arrancar con los puntos de `RADAR_CALIBRATION` (`lib/nitrato.js`): LiDAR jun-2026 y mediciones manuales nov-2026, todas referidas como la planilla (medición − 0.09 m de escotilla). Hoy: `1.039·radar − 0.072`, error < 9 cm. Para recalibrar, agregar filas y reiniciar; el log de arranque muestra la recta.

| Distancia real        | Nivel                                                         |
|-----------------------|---------------------------------------------------------------|
| ≤ 5.95 m              | Columna: nivel = 7.89 − distancia                             |
| 5.95 – 6.73 m         | Embudo intermedio: nivel = 7.89 − distancia (se muestra `≈`)  |
| 6.73 m – lectura vacío | Embudos finales, aproximado hasta el nivel de silo vacío (`≈`) |
| radar ≥ 7.05 m        | Silo vacío: masa residual `NITRATO_MASA_VACIO_TON` (0.10 t)   |

El radar no alcanza a ver el fondo de los dos embudos finales (con el silo vacío lee ~7.05 m), por eso esa zona es aproximada.

**Recalcular historial al cambiar el modelo.** El historial guarda valores ya calculados (t y %). Si cambia el modelo de cálculo, los puntos anteriores quedan con el modelo viejo y el gráfico muestra un salto. `tools/recalcular-historial-nitrato.js` reconstruye la lectura del radar desde el % guardado y recalcula cada punto con el modelo actual (por silo, totalizador y turno), con respaldo automático en `backups/`:

```sh
pm2 stop scada-silos
node tools/recalcular-historial-nitrato.js              # simulación: muestra los cambios
node tools/recalcular-historial-nitrato.js --aplicar    # aplica (--dias N o --todo para días anteriores)
pm2 start scada-silos
```

Los días ya convertidos quedan registrados en `nitrato_recalculo.json` y no se convierten dos veces.

---

## MQTT — Topics

Payload Delta HMI con word-swap: `{ "d": { "tipo": 12345678 } }` (uint32 → float = distancia del radar en metros).

| Sistema  | Topics                                        | Silo                    |
|----------|-----------------------------------------------|-------------------------|
| Matriz   | `planta/losbronces/silos/tanque1` … `tanque8` | Silo 1 … Silo 8         |
| Nitrato  | `planta/losbronces/silos/tanque11` … `tanque18` | Silo 1 … Silo 8 Nitrato |

Matriz y Nitrato usan el mismo HMI y prefijo: `tanque1`…`tanque8` son Matriz y `tanque11`…`tanque18` son Nitrato. Nitrato identifica el silo por el último segmento del topic (también acepta `silo11`…`silo18` como alias). Para cambiar la suscripción, usar `MQTT_TOPIC_NITRATO` (separadas por coma).

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

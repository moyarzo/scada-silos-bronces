// Configuración PM2 para producción
// Uso: pm2 start ecosystem.config.js

module.exports = {
  apps: [
    {
      name: "scada-silos",
      script: "server.js",
      watch: false,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
        PORT: 3000
      },
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    }
  ]
};

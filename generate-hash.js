// Uso: node generate-hash.js "miContraseñaSegura"
// Copia el resultado en el .env como USERx_HASH

const bcrypt = require("bcryptjs");

const password = process.argv[2];

if (!password) {
  console.log('Uso: node generate-hash.js "tu_contraseña"');
  process.exit(1);
}

bcrypt.hash(password, 10, function (err, hash) {
  if (err) {
    console.error("Error generando hash:", err);
    process.exit(1);
  }
  console.log(hash);
});

const express = require('express');
const router = express.Router();
// Importa cualquier librería para interactuar con USB si es necesario

router.post('/abrir', (req, res) => {
  try {
    // Aquí el código para abrir el cajón
    res.json({ error: false, mensaje: 'Cajón abierto con éxito!' });
  } catch (err) {
    res.json({ error: true, mensaje: 'Error al abrir el cajón' });
  }
});

module.exports = router;



//electron-packager . MiAplicacion --platform=win32 --arch=x64 --out=./ --overwrite

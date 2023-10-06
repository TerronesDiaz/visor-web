const express = require('express');
const ThermalPrinter = require("node-thermal-printer").printer;
const PrinterTypes = require("node-thermal-printer").types;
const router = express.Router();

let printer = new ThermalPrinter({
  type: PrinterTypes.EPSON,
  interface: '/dev/usb/lp0',
  options: {
    timeout: 5000
  }
});

router.post('/abrir', async (req, res) => {
  try {
    if (!printer.isPrinterConnected()) {
      return res.status(500).json({ error: true, mensaje: "Impresora no conectada" });
    }

    printer.openCashDrawer();  // Comando para abrir el cajón de dinero

    try {
      await printer.execute();
      res.json({ error: false, mensaje: 'Cajón abierto con éxito!' });
    } catch (error) {
      console.error("Error al ejecutar comando:", error);
      res.status(500).json({ error: true, mensaje: 'Error al abrir el cajón' });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: true, mensaje: 'Error al abrir el cajón' });
  }
});

module.exports = router;

const express = require("express");
const { ThermalPrinter, PrinterTypes, CharacterSet, BreakLine } = require('node-thermal-printer');
const path = require('path');


const impresoraRoutes = express.Router();

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_SERVER_ERROR = 500;

let printer = new ThermalPrinter({
  type: PrinterTypes.EPSON,  // Asegúrate de que el tipo de impresora sea correcto
  interface: '\\\\DESKTOP-DUA5KMM\\EPSON_TM_T20III',  // Ruta de la impresora compartida
  characterSet: CharacterSet.SPANISH,
  removeSpecialCharacters: false,
  lineCharacter: "=",
  breakLine: BreakLine.WORD,
  options:{
    timeout: 5000
  }
});

const validateData = (data) => {
  if (!data) return false;

  // Validación de productos
  if (!Array.isArray(data.productos)) return false;
  for (const producto of data.productos) {
    if (typeof producto.id !== 'number' || typeof producto.codigo !== 'string' || 
        typeof producto.descripcion !== 'string' || typeof producto.cantidad !== 'number' || 
        typeof producto.importe !== 'number') {
      return false;
    }
  }

  // Validación de otros datos
  if (typeof data.otros_datos !== 'object' || typeof data.otros_datos.numeroCaja !== 'string' || 
      typeof data.otros_datos.cajero !== 'string' || typeof data.otros_datos.idCajero !== 'string' || 
      typeof data.otros_datos.cliente !== 'string' || typeof data.otros_datos.idCliente !== 'string' || 
      typeof data.otros_datos.fechaHora !== 'string') {
    return false;
  }

  // Validación de totales
  if (typeof data.totales !== 'object' || typeof data.totales.noPiezas !== 'string' || 
      typeof data.totales.iva !== 'string' || typeof data.totales.subtotal !== 'string' || 
      typeof data.totales.descuento !== 'string' || typeof data.totales.totalSinIva !== 'string' || 
      typeof data.totales.total !== 'string') {
    return false;
  }

  // Validación de método de pago
  if (!Array.isArray(data.metodoPago)) return false;
  for (const pago of data.metodoPago) {
    if (typeof pago.idFormaPago !== 'string' || typeof pago.metodoPago !== 'string' || 
        typeof pago.importe !== 'number') {
      return false;
    }
  }

  return true;
};



impresoraRoutes.post("/imprimir", async (req, res, next) => {
  try {
    const data = req.body;

    // Validación de datos de entrada
    if (!validateData(data)) {
      return res.status(HTTP_STATUS_SERVER_ERROR).json({ error: true, mensaje: 'Datos no válidos' });
    }

    try {
      let isConnected = await printer.isPrinterConnected();
      if (!isConnected) {
        console.log("Fallo en la conexión con la impresora");
        return res.status(HTTP_STATUS_SERVER_ERROR).json({ error: true, mensaje: "Impresora no conectada" });
      }
    } catch (error) {
      console.log("Error al verificar la conexión de la impresora:", error);
      return res.status(HTTP_STATUS_SERVER_ERROR).json({ error: true, mensaje: "Error al verificar la conexión de la impresora" });
    }
    

    const logoPath = path.join(__dirname, '../../assets/images/terronescolima-logo.png');
    
    printer.alignCenter();
    await printer.printImage(logoPath);

    printer
      .setTextDoubleHeight()
      .println('SUCESORES DE DONACIANO TERRONES SERRANO, S.A. DE C.V.'.toUpperCase())
      .println('DOMICILIO: PINO SUAREZ #72 COLIMA, COL.'.toUpperCase())
      .println('TELÉFONO: 3123133162'.toUpperCase())
      .println('RFC: STD-900718-8C5'.toUpperCase())
      .setTextNormal()
      .println('----------------'.toUpperCase())
      .alignLeft();

    data.productos.forEach(producto => {
      printer
        .println(`ID: ${producto.id.toString().toUpperCase()}`)
        .println(`CÓDIGO: ${producto.codigo.toUpperCase()}`)
        .println(`DESCRIPCIÓN: ${producto.descripcion.toUpperCase()}`)
        .println(`CANTIDAD: ${producto.cantidad.toString().toUpperCase()}`)
        .println(`IMPORTE: ${producto.importe.toString().toUpperCase()}`)
        .println('----------------'.toUpperCase());
    });

    printer
      .println(`NO. PIEZAS: ${data.totales.noPiezas}`.toUpperCase())
      .println(`IVA: ${data.totales.iva}`.toUpperCase())
      .println(`SUBTOTAL: ${data.totales.subtotal}`.toUpperCase())
      .println(`DESCUENTO: ${data.totales.descuento}`.toUpperCase())
      .println(`TOTAL S/IVA: ${data.totales.totalSinIva}`.toUpperCase())
      .println(`TOTAL: ${data.totales.total}`.toUpperCase())
      .println('----------------'.toUpperCase());

    data.metodoPago.forEach(pago => {
      printer
        .println(`FORMA DE PAGO: ${pago.metodoPago}`.toUpperCase())
        .println(`IMPORTE: ${pago.importe}`.toUpperCase());
    });

    printer.cut();

    try {
      await printer.execute();
      console.log("Impresión completada");
      res.status(HTTP_STATUS_OK).json({ error: false, mensaje: "Impresión completada" });
      next();
    } catch (printError) {
      console.error("Error de impresión:", printError.stack || printError);
      res.status(HTTP_STATUS_SERVER_ERROR).json({ error: true, mensaje: "Error de impresión" });
    }
  } catch (middlewareError) {
    console.error("Error en el middleware de impresión:", middlewareError.stack || middlewareError);
    res.status(HTTP_STATUS_SERVER_ERROR).json({ error: true, mensaje: 'Error en el middleware de impresión' });
  }
});

module.exports = impresoraRoutes;

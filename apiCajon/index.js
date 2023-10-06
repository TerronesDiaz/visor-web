const express = require("express");
const cors = require("cors");
const cajonRoutes = require("./routes/cajon");
const impresoraRoutes = require("./routes/impresora");

const app = express();
const port = 3000;

app.use(express.json());
app.use(cors());

app.use("/cajon", cajonRoutes);
app.use("/impresora", impresoraRoutes);

app.use((err, req, res, next) => {
  console.error("Error Middleware:", err.stack);
  res.status(500).json({ error: true, mensaje: "Algo salió mal." });
});

app.use("*", (req, res) => {
  console.log("404 Middleware: Ruta no encontrada");
  res.status(404).json({ error: true, mensaje: "Ruta no encontrada." });
});

function start() {
  app.listen(port, () => {
    console.log(`API escuchando en: http://localhost:${port}`);
  });
}

module.exports = { start };

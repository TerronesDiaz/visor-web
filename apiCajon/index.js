const express = require('express');
const cors = require('cors');
const cajonRoutes = require('./routes/cajon');

const app = express();
const port = 3000;

// Habilitar CORS
app.use(cors());

app.use('/cajon', cajonRoutes);

app.listen(port, () => {
  console.log(`API escuchando en: http://localhost:${port}`);
});


//electron-packager . MiAplicacion --platform=win32 --arch=x64 --out=./ --overwrite
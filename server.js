const express = require('express');
const bodyParser = require('body-parser');
const { handler } = require('./whatsapp'); // tu función handler de whatsapp.js

const app = express();
app.use(bodyParser.json({ limit: '15mb' }));

// Endpoint de salud
app.get('/health', (req, res) => res.status(200).send('OK'));

// Endpoint de verificación de Webhook (Facebook)
app.get('/webhook', async (req, res) => {
  try {
    const event = {
      httpMethod: 'GET',
      queryStringParameters: req.query
    };
    const result = await handler(event);
    res.status(result.statusCode).send(result.body);
  } catch (err) {
    console.error('Error en GET /webhook:', err);
    res.status(500).send('Internal Server Error');
  }
});

// Endpoint de recepción de mensajes
app.post('/webhook', async (req, res) => {
  try {
    const event = {
      httpMethod: 'POST',
      body: JSON.stringify(req.body),
      isBase64Encoded: false
    };
    const result = await handler(event);
    res.status(result.statusCode).send(result.body);
  } catch (err) {
    console.error('Error en POST /webhook:', err);
    res.status(500).send('Internal Server Error');
  }
});

// Arranque del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook listening on port ${PORT}`);
});
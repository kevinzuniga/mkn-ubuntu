require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { handler } = require('./whatsapp');
const { getSecretValue } = require('./secrets');

const app = express();
app.use(bodyParser.json({ limit: '15mb' }));

// Health endpoint
app.get('/health', (_req, res) => res.status(200).send('OK'));

// WhatsApp webhook verification
app.get('/webhook', async (req, res) => {
  try {
    const result = await handler({
      httpMethod: 'GET',
      queryStringParameters: req.query
    });
    res.status(result.statusCode).send(result.body);
  } catch (err) {
    console.error('Error GET /webhook:', err);
    res.status(500).send('Internal Server Error');
  }
});

// WhatsApp message handling
app.post('/webhook', async (req, res) => {
  try {
    const result = await handler({
      httpMethod: 'POST',
      body: JSON.stringify(req.body),
      isBase64Encoded: false
    });
    res.status(result.statusCode).send(result.body);
  } catch (err) {
    console.error('Error POST /webhook:', err);
    res.status(500).send('Internal Server Error');
  }
});

// Test AWS Secrets endpoint
app.get('/test-secrets', async (_req, res) => {
  try {
    const [wwdr, signer, key] = await Promise.all([
      getSecretValue(process.env.WWDR_CERT_NAME),
      getSecretValue(process.env.SIGNER_CERT_NAME),
      getSecretValue(process.env.SIGNER_KEY_NAME)
    ]);
    res.json({
      wwdr: wwdr.toString(),
      signer: signer.toString(),
      key: key.toString()
    });
  } catch (err) {
    console.error('Error GET /test-secrets:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
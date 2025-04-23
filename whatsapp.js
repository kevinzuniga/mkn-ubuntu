'use strict';

// ────────────────────────── DEPENDENCIAS ──────────────────────────
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const Jimp = require('jimp');
const { PKPass } = require('passkit-generator'); // v3
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { RekognitionClient, DetectFacesCommand } = require('@aws-sdk/client-rekognition');
const OpenAI = require('openai');
const { getSecretValue } = require('./secrets');

// ────────────────────────── ENTORNO ──────────────────────────
const {
  WA_PHONE_NUMBER_ID,
  WA_CLOUD_API_ACCESS_TOKEN,
  VERIFY_TOKEN = 'mkn-api-whatsapp-token',
  BUCKET_NAME,
  APPLE_PASS_TYPE_ID,
  APPLE_TEAM_ID,
  ORGANIZATION_NAME,
  OPENAI_API_KEY,
  AWS_REGION = 'us-east-1'
} = process.env;
// Nombres de secretos (con valores por defecto si no están en env)
const WWDR_CERT_NAME = '/mkn/wwdrCert-v2';
const SIGNER_CERT_NAME = '/mkn/signerCert-v2';
const SIGNER_KEY_NAME = '/mkn/signerKey-v2';

const API_VERSION = 'v21.0';

// AWS clients
const region = AWS_REGION;
const s3 = new S3Client({ region });
const rekog = new RekognitionClient({ region });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Servidor Express
const app = express();
app.use(bodyParser.json({ limit: '15mb' }));

// Healthcheck
app.get('/health', (_req, res) => res.status(200).send('OK'));

// Verificación Webhook
app.get('/webhook', async (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Verification failed');
});

// Manejo de mensajes
app.post('/webhook', async (req, res) => {
  console.info('WhatsApp webhook event received');
  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) {
    console.info('No message found in payload');
    return res.status(200).json({ message: 'No message' });
  }
  if (msg.type !== 'image' || !msg.image?.id) {
    await sendText(msg.from, 'Por favor envía una imagen para generar tu pase.');
    return res.status(200).json({ message: 'Non-image' });
  }

  try {
    // 1. Descargar imagen
    console.info('Initiating media download for ID:', msg.image.id);
    const mediaBuf = await downloadMedia(msg.image.id);

    // 2. Detectar caras
    console.info('Calling Rekognition');
    const rek = await rekog.send(new DetectFacesCommand({ Image: { Bytes: mediaBuf } }));
    console.info('Rekognition found faces:', rek.FaceDetails.length);
    if (!rek.FaceDetails.length) {
      await sendText(msg.from, 'No se detectó rostro. Intenta con otra imagen.');
      return res.status(200).json({ message: 'No face' });
    }
    const biggest = rek.FaceDetails.reduce((max, f) => {
      const area = f.BoundingBox.Width * f.BoundingBox.Height;
      return area > max.area ? { area, box: f.BoundingBox } : max;
    }, { area: 0, box: null }).box;

    // 3. Cortar y obtener buffer PNG
    console.info('Cropping face using Jimp');
    const image = await Jimp.read(mediaBuf);
    const facePNG = await image.crop(
      Math.floor(biggest.Left * image.getWidth()),
      Math.floor(biggest.Top * image.getHeight()),
      Math.floor(biggest.Width * image.getWidth()),
      Math.floor(biggest.Height * image.getHeight())
    ).getBufferAsync(Jimp.MIME_PNG);
    console.info('Cropped face size:', facePNG.length);

    // 4. Extraer nombre con OpenAI
    console.info('Calling OpenAI to extract name');
    let fullName = 'N/A';
    try {
      const ai = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Devuélveme un JSON con "adultName".' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${mediaBuf.toString('base64')}` } }
            ]
          }
        ],
        max_tokens: 60,
        response_format: { type: 'json_object' }
      });
      const c = ai.choices?.[0]?.message?.content;
      fullName = c ? JSON.parse(c).adultName || 'N/A' : 'N/A';
    } catch (err) {
      console.warn('OpenAI error:', err.message);
    }

    // 5. Cargar certificados desde Secrets Manager
    console.info('Loading certificates');
    const [wwdr, signerCert, signerKey] = await Promise.all([
      getSecretValue(WWDR_CERT_NAME),
      getSecretValue(SIGNER_CERT_NAME),
      getSecretValue(SIGNER_KEY_NAME)
    ]);

    // 6. Crear modelo de pase
    const model = {
      formatVersion: 1,
      passTypeIdentifier: APPLE_PASS_TYPE_ID,
      teamIdentifier: APPLE_TEAM_ID,
      organizationName: ORGANIZATION_NAME,
      description: 'Digital ID Pass',
      serialNumber: `pass-${msg.image.id}-${Date.now()}`,
      foregroundColor: 'rgb(255,255,255)',
      backgroundColor: 'rgb(60,65,70)',
      labelColor: 'rgb(255,255,255)',
      generic: {
        headerFields: [{ key: 'header', label: 'Digital ID', value: '' }],
        primaryFields: [{ key: 'name', label: 'Full Name', value: fullName }]
      }
    };

    // 7. Crear carpeta .pass y escribir archivos
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pkmodel-'));
    const modelDir = `${tmp}.pass`;
    await fs.mkdir(modelDir);
    await fs.writeFile(path.join(modelDir, 'pass.json'), JSON.stringify(model, null, 2));
    await fs.copyFile(path.join(__dirname, 'icon.png'), path.join(modelDir, 'icon.png'));
    await fs.copyFile(path.join(__dirname, 'logo.png'), path.join(modelDir, 'logo.png'));

    // 8. Generar pase y buffer
    console.info('Generating pass…');
    const passInstance = await PKPass.from({ model: modelDir, certificates: { wwdr, signerCert, signerKey } });
    passInstance.images.add('thumbnail', facePNG);
    passInstance.images.add('thumbnail@2x', facePNG);
    const dotPNG = await fs.readFile(path.join(__dirname, 'icon.png'));
    ['icon','icon@2x','logo','logo@2x'].forEach(name => passInstance.images.add(name, dotPNG));
    const passBuffer = await passInstance.getAsBuffer();

    // 9. Subir a S3 y notificar
    const key = `passes/${msg.image.id}.pkpass`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, Body: passBuffer, ContentType: 'application/vnd.apple.pkpass', ACL: 'public-read' }));
    const url = `https://${BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
    await sendText(msg.from, `¡Tu pase está listo! Descárgalo aquí: ${url}`);
    return res.status(200).json({ passUrl: url });

  } catch (err) {
    console.error('Error processing message:', err);
    await sendText(msg.from, 'Lo siento, ocurrió un error generando tu pase. Inténtalo de nuevo.');
    return res.status(500).json({ error: err.message });
  }
});

// Helper para descargar media
async function downloadMedia(mediaId) {
  const infoUrl = `https://graph.facebook.com/${API_VERSION}/${mediaId}`;
  const { data } = await axios.get(infoUrl, { headers: { Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}` } });
  if (!data?.url) throw new Error('No download URL');
  const media = await axios.get(data.url, { headers: { Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}` }, responseType: 'arraybuffer' });
  return Buffer.from(media.data);
}

// Helper para enviar texto por WhatsApp
async function sendText(to, body) {
  const url = `https://graph.facebook.com/${API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
  await axios.post(url, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body, preview_url: false } }, { headers: { Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

// Arrancar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

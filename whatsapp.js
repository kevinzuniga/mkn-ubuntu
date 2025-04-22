'use strict';

/* ──────────────────────────  DEPENDENCIAS  ────────────────────────── */
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const Jimp = require('jimp');

const { PKPass } = require('passkit-generator');           // v3
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { RekognitionClient, DetectFacesCommand } = require('@aws-sdk/client-rekognition');
const OpenAI = require('openai');
const { getSecretValue } = require('./secrets');

/* ──────────────────────────  ENV  ────────────────────────── */
const {
  WA_ACCOUNT_ID,
  WA_PHONE_NUMBER_ID,
  WA_PHONE_NUMBER,
  WA_CLOUD_API_ACCESS_TOKEN,
  VERIFY_TOKEN = 'mkn-api-whatsapp-token',
  BUCKET_NAME,
  APPLE_PASS_TYPE_ID,
  APPLE_TEAM_ID,
  ORGANIZATION_NAME,
  OPENAI_API_KEY,
  AWS_REGION = 'us-east-1'
} = process.env;

const API_VERSION = 'v21.0';

/* AWS & OpenAI */
const region = AWS_REGION;
const s3 = new S3Client({ region });
const rekog = new RekognitionClient({ region });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });


/* ──────────────────────────  HELPERS  ────────────────────────── */
async function downloadMedia(mediaId) {
  console.info('Initiating media download for ID:', mediaId);
  const infoUrl = `https://graph.facebook.com/${API_VERSION}/${mediaId}`;
  const { data } = await axios.get(infoUrl, {
    headers: { Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}` }
  });
  if (!data?.url) throw new Error('No download URL in mediaInfo');

  const media = await axios.get(data.url, {
    headers: { Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}` },
    responseType: 'arraybuffer'
  });
  console.info('Media downloaded, size:', media.data.length);
  return Buffer.from(media.data);
}

async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/${API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body, preview_url: false } },
    { headers: { Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

/* ──────────────────────────  HANDLER  ────────────────────────── */
module.exports.handler = async (event) => {
  console.info('WhatsApp webhook event received');

  /* 1. VERIFICACIÓN WEBHOOK */
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === VERIFY_TOKEN) {
      return { statusCode: 200, body: q['hub.challenge'] };
    }
    return { statusCode: 403, body: 'Verification failed' };
  }

  /* 2. PROCESAR MENSAJE */
  if (event.httpMethod === 'POST') {
    const body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body || '{}');
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) {
      console.info('No message found in payload');
      return { statusCode: 200, body: JSON.stringify({ message: 'No message' }) };
    }

    const sender = msg.from;
    if (msg.type !== 'image' || !msg.image?.id) {
      await sendWhatsAppText(sender, 'Por favor envía una imagen para generar tu pase.');
      return { statusCode: 200, body: JSON.stringify({ message: 'Non-image' }) };
    }

    try {
      /* 2.1 Descargar imagen */
      const mediaBuf = await downloadMedia(msg.image.id);

      /* 2.2 Detectar caras */
      console.info('Calling Rekognition');
      const rek = await rekog.send(new DetectFacesCommand({ Image: { Bytes: mediaBuf } }));
      console.info('Rekognition found faces:', rek.FaceDetails.length);
      if (!rek.FaceDetails.length) {
        await sendWhatsAppText(sender, 'No se detectó rostro. Intenta con otra imagen.');
        return { statusCode: 200, body: JSON.stringify({ message: 'No face' }) };
      }

      /* 2.3 Extraer la cara más grande */
      const biggest = rek.FaceDetails.reduce((acc, f) => {
        const a = f.BoundingBox.Width * f.BoundingBox.Height;
        return a > acc.area ? { area: a, box: f.BoundingBox } : acc;
      }, { area: 0, box: null }).box;

      console.info('Cropping face using Jimp');
      const j = await Jimp.read(mediaBuf);
      const face = await j.crop(
        Math.floor(biggest.Left * j.getWidth()),
        Math.floor(biggest.Top * j.getHeight()),
        Math.floor(biggest.Width * j.getWidth()),
        Math.floor(biggest.Height * j.getHeight())
      ).getBufferAsync(Jimp.MIME_PNG);

      console.info('Cropped face size:', face.length);

      /* 2.4 Llamar a OpenAI (opcional) */
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
        if (c) fullName = JSON.parse(c).adultName || 'N/A';
        else console.warn('OpenAI devolvió content = null; usando N/A');
      } catch (e) {
        console.error('OpenAI error (continuing with N/A):', e.message);
      }
      console.info('OpenAI extracted name:', fullName);

      /* 2.5 Leer certificados */
      console.info('Loading certificates');
      const [wwdr, signerCert, signerKey] = await Promise.all([
        getSecretValue('mkn/wwdrCert-v2'),
        getSecretValue('mkn/signerCert-v2'),
        getSecretValue('mkn/signerKey-v2')
      ]);
      console.info('Certificates loaded; lengths:', wwdr.length, signerCert.length, signerKey.length);

      /* 2.6 Construir directorio‑modelo temporal */
      // ----------   1)  construir el modelo  ----------
      const modelObject = {
        formatVersion: 1,
        passTypeIdentifier: APPLE_PASS_TYPE_ID,
        teamIdentifier: APPLE_TEAM_ID,
        organizationName: ORGANIZATION_NAME,
        description: 'Digital ID Pass',
        serialNumber: `pass-${message.image.id}-${Date.now()}`,
        foregroundColor: 'rgb(255,255,255)',
        backgroundColor: 'rgb(60,65,70)',
        labelColor: 'rgb(255,255,255)',
        generic: {
          headerFields: [{ key: 'header', label: 'Digital ID', value: '' }],
          primaryFields: [{ key: 'name', label: 'Full Name', value: fullName }],
        }
      };

      // ----------   2)  directorio temporal con pass.json  ----------
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pk-model-'));
      await fs.writeFile(path.join(tmpDir, 'pass.json'),
        JSON.stringify(modelObject, null, 2));

      // ----------   3)  Instanciar el pase  ----------
      console.info('Generating pass (passkit-generator v3)');
      const pass = await PKPass.from({
        model: tmpDir,                            // <–– AHORA EXISTE
        certificates: { wwdr, signerCert, signerKey }
      });

      // ----------   4)  Añadir imágenes y generar buffer  ----------
      pass.images.add('thumbnail', facePNG);
      pass.images.add('thumbnail@2x', facePNG);
      ['icon', 'icon@2x', 'logo', 'logo@2x'].forEach(k => pass.images.add(k, dotPNG));

      console.info('Generating pass buffer…');
      const passBuffer = await pass.getAsBuffer();
      console.info('Pass buffer size:', passBuffer.length, 'bytes');

      const key = `passes/${msg.image.id}.pkpass`;
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: 'application/vnd.apple.pkpass',
        ACL: 'public-read'
      }));
      const url = `https://${BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
      console.info('Pass uploaded to:', url);

      /* 2.9 Notificar al usuario */
      await sendWhatsAppText(sender, `¡Tu pase está listo! Descárgalo aquí: ${url}`);
      return { statusCode: 200, body: JSON.stringify({ passUrl: url }) };
    } catch (err) {
      console.error('Error processing message:', err);
      await sendWhatsAppText(sender, 'Lo siento, ocurrió un error generando tu pase. Inténtalo de nuevo.');
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  /* Método no soportado */
  return { statusCode: 405, body: 'Method Not Allowed' };
};
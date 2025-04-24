'use strict';

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const Jimp = require('jimp');
const PKPass = require('passkit-generator').PKPass;
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { RekognitionClient, DetectFacesCommand } = require('@aws-sdk/client-rekognition');
const OpenAI = require('openai');
const forge = require('node-forge');   // ← nueva línea
const { getSecretValue } = require('./secrets');

// Environment variables
const {
  WA_PHONE_NUMBER_ID,
  WA_CLOUD_API_ACCESS_TOKEN,
  VERIFY_TOKEN = 'mkn-api-whatsapp-token',
  BUCKET_NAME,
  APPLE_PASS_TYPE_ID,
  APPLE_TEAM_ID,
  ORGANIZATION_NAME,
  OPENAI_API_KEY,
  AWS_REGION = 'us-east-1',
  WWDR_CERT_NAME,
  SIGNER_CERT_NAME,
  SIGNER_KEY_NAME
} = process.env;
const API_VERSION = 'v21.0';

// AWS clients
const s3 = new S3Client({ region: AWS_REGION });
const rekog = new RekognitionClient({ region: AWS_REGION });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Download media from WhatsApp
async function downloadMedia(mediaId) {
  const infoUrl = `https://graph.facebook.com/${API_VERSION}/${mediaId}`;
  const { data } = await axios.get(infoUrl, {
    headers: { Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}` }
  });
  if (!data.url) throw new Error('No download URL');
  const media = await axios.get(data.url, {
    headers: { Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}` },
    responseType: 'arraybuffer'
  });
  return Buffer.from(media.data);
}

// Send text via WhatsApp
async function sendText(to, body) {
  const url = `https://graph.facebook.com/${API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: false }
    },
    {
      headers: {
        Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// Main handler
async function handler(event) {
  // Webhook verification
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === VERIFY_TOKEN) {
      return { statusCode: 200, body: q['hub.challenge'] };
    }
    return { statusCode: 403, body: 'Verification failed' };
  }

  // Process message
  if (event.httpMethod === 'POST') {
    const body = JSON.parse(
      event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString()
        : event.body || '{}'
    );
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return { statusCode: 200, body: JSON.stringify({ message: 'No message' }) };
    if (msg.type !== 'image' || !msg.image?.id) {
      await sendText(msg.from, 'Por favor envía una imagen para generar tu pase.');
      return { statusCode: 200, body: JSON.stringify({ message: 'Non-image' }) };
    }

    try {
      // 1. Download image
      const mediaBuf = await downloadMedia(msg.image.id);

      // 2. Detect faces
      const rek = await rekog.send(
        new DetectFacesCommand({ Image: { Bytes: mediaBuf } })
      );
      if (!rek.FaceDetails.length) {
        await sendText(msg.from, 'No se detectó rostro. Intenta con otra imagen.');
        return { statusCode: 200, body: JSON.stringify({ message: 'No face' }) };
      }
      const biggest = rek.FaceDetails.reduce(
        (max, f) => {
          const area = f.BoundingBox.Width * f.BoundingBox.Height;
          return area > max.area ? { area, box: f.BoundingBox } : max;
        },
        { area: 0, box: null }
      ).box;

      // 3. Crop face
      const image = await Jimp.read(mediaBuf);
      const facePNG = await image
        .crop(
          Math.floor(biggest.Left * image.getWidth()),
          Math.floor(biggest.Top * image.getHeight()),
          Math.floor(biggest.Width * image.getWidth()),
          Math.floor(biggest.Height * image.getHeight())
        )
        .getBufferAsync(Jimp.MIME_PNG);

      // 4. Extract name via OpenAI
      let fullName = 'N/A';
      try {
        const ai = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Devuélveme un JSON con "adultName".' },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${mediaBuf.toString('base64')}` }
                }
              ]
            }
          ],
          max_tokens: 60,
          response_format: { type: 'json_object' }
        });
        const c = ai.choices?.[0]?.message?.content;
        fullName = c?.adultName ?? 'N/A';
      } catch (err) {
        console.warn('OpenAI error:', err.message);
      }

      // 5. Load certs
      function unwrapPem(raw) {
        raw = raw.toString().trim();
        if (raw.startsWith('{')) raw = Object.values(JSON.parse(raw))[0].trim();
        return raw;
      }
      
      function ensureRsaPrivateKey(pem) {
        const pk = forge.pki.privateKeyFromPem(pem);     // acepta PKCS#8
        return /RSA PRIVATE KEY/.test(pem)
          ? pem
          : forge.pki.privateKeyToPem(pk, 72);
      }
      
      let [wwdrPem, certPem, keyPem] = await Promise.all([
        getSecretValue(WWDR_CERT_NAME),
        getSecretValue(SIGNER_CERT_NAME),
        getSecretValue(SIGNER_KEY_NAME)
      ]);
      
      wwdrPem = unwrapPem(wwdrPem);
      certPem = unwrapPem(certPem);
      keyPem  = ensureRsaPrivateKey( unwrapPem(keyPem) );

      [wwdrPem, certPem, keyPem].forEach((pem, i) => {
        console.log(['WWDR','CERT','KEY'][i], 'first bytes →', pem.slice(0, 40));
      });
      const certificates = { wwdr: wwdrPem, signerCert: certPem, signerKey: keyPem };

      // 6. Build pass model
      const modelObj = {
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

      // 7. Create .pass folder
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pk-model-'));
      const modelDir = `${tmp}.pass`;
      await fs.mkdir(modelDir);
      await fs.writeFile(
        path.join(modelDir, 'pass.json'),
        JSON.stringify(modelObj, null, 2)
      );
      const iconPath = path.join(__dirname, 'icon.png');
      const logoPath = path.join(__dirname, 'logo.png');
      await fs.copyFile(iconPath, path.join(modelDir, 'icon.png'));
      await fs.copyFile(logoPath, path.join(modelDir, 'logo.png'));

      // 8. Generate pass     
      const passInst = await PKPass.from({ model: modelDir, certificates });

      passInst.addBuffer('thumbnail', facePNG);
      passInst.addBuffer('thumbnail@2x', facePNG);

      const dotPNG = await fs.readFile(path.join(__dirname, 'icon.png'));
      ['icon', 'icon@2x', 'logo', 'logo@2x'].forEach(name =>
        passInst.addBuffer(name, dotPNG)
      );
      const passBuffer = await passInst.getAsBuffer();

      // 9. Upload and notify
      const key = `passes/${msg.image.id}.pkpass`;
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: passBuffer,
        ContentType: 'application/vnd.apple.pkpass',
        ACL: 'public-read'
      }));
      const url = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
      await sendText(msg.from, `¡Tu pase está listo! Descárgalo aquí: ${url}`);
      return { statusCode: 200, body: JSON.stringify({ passUrl: url }) };
    } catch (err) {
      console.error('Error processing message:', err);
      await sendText(msg.from, 'Lo siento, ocurrió un error generando tu pase. Inténtalo de nuevo.');
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
}

module.exports = { handler };

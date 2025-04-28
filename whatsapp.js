'use strict';

// ———‑‑ DEPENDENCIAS ———‑‑
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Jimp = require('jimp');
const { PKPass } = require('passkit-generator');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { RekognitionClient, DetectFacesCommand } = require('@aws-sdk/client-rekognition');
const OpenAI = require('openai');
const forge = require('node-forge');
const jsQR = require('jsqr');
const { getSecretValue } = require('./secrets');

// ———‑‑ ENV ———‑‑
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
const s3 = new S3Client({ region: AWS_REGION });
const rekog = new RekognitionClient({ region: AWS_REGION });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Guarda IDs procesados para evitar duplicados en el mismo proceso
const processed = new Set();

/* ---------- helpers ---------- */
const log = (...args) => console.info('[WHATSAPP]', ...args);

async function downloadMedia(id) {
  const infoUrl = `https://graph.facebook.com/${API_VERSION}/${id}`;
  const { data } = await axios.get(infoUrl, { headers: { Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}` } });
  const { data: bin } = await axios.get(data.url, { headers: { Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}` }, responseType: 'arraybuffer' });
  return Buffer.from(bin);
}

async function sendText(to, body) {
  await axios.post(`https://graph.facebook.com/${API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body, preview_url: false } },
    { headers: { Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
}

function unwrapPem(raw) {
  raw = raw.toString().trim();
  if (raw.startsWith('{')) raw = Object.values(JSON.parse(raw))[0].trim();
  return raw;
}

function ensureRsaPrivateKey(pem) {
  const pk = forge.pki.privateKeyFromPem(pem);
  return /RSA PRIVATE KEY/.test(pem) ? pem : forge.pki.privateKeyToPem(pk, 72);
}

/* ---------- handler ---------- */
async function handler(event) {
  /* webhook verify */
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    return q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === VERIFY_TOKEN
      ? { statusCode: 200, body: q['hub.challenge'] }
      : { statusCode: 403, body: 'Verification failed' };
  }

  /* message */
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const body = JSON.parse(event.body || '{}');

  const change = body?.entry?.[0]?.changes?.[0]?.value;
  const msg = change?.messages?.[0];
  if (!msg || msg.type !== 'image') {
    return { statusCode: 200, body: 'non-image or status' };
  }

  if (processed.has(msg.id)) { log('skip duplicate', msg.id); return { statusCode: 200, body: 'dup' }; }
  processed.add(msg.id);

  log('incoming msg id', msg.id);
  const sender = msg.from;
  if (msg.type !== 'image') { await sendText(sender, 'Envía una imagen.'); return { statusCode: 200, body: 'non‑image' }; }

  try {
    // 1 download
    const mediaBuf = await downloadMedia(msg.image.id);
    log('media size', mediaBuf.length);

    // save original to S3 for debug
    const rawKey = `raw/${msg.image.id}.jpg`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: rawKey, Body: mediaBuf, ContentType: 'image/jpeg', ACL: 'public-read' }));

    // 2 rekognition
    const rek = await rekog.send(new DetectFacesCommand({ Image: { Bytes: mediaBuf } }));
    log('faces detected', rek.FaceDetails.length);
    if (!rek.FaceDetails.length) { await sendText(sender, 'No se detectó rostro.'); return { statusCode: 200 }; }
    const big = rek.FaceDetails.reduce((m, f) => { const a = f.BoundingBox.Width * f.BoundingBox.Height; return a > m.a ? { a, box: f.BoundingBox } : m; }, { a: 0, box: null }).box;

    // 3 crop
    const j = await Jimp.read(mediaBuf);
    const scale = 1.6;
    const W = j.getWidth(), H = j.getHeight();
    const x = Math.max(0, Math.floor((big.Left - (scale - 1) / 2 * big.Width) * W));
    const y = Math.max(0, Math.floor((big.Top - (scale - 1) / 2 * big.Height) * H));
    const w = Math.min(W - x, Math.floor(big.Width * W * scale));
    const h = Math.min(H - y, Math.floor(big.Height * H * scale));
    const facePNG = await j.crop(x, y, w, h).getBufferAsync(Jimp.MIME_PNG);

    // ensure we have RGBA data
    const qrImg = j.clone();
    let qrRegion = qrImg.contrast(0.5);  // increase contrast
    qrRegion = qrRegion.greyscale();  // convert to grayscale
    const { data, width, height } = qrRegion.bitmap;
    const qr = jsQR(new Uint8ClampedArray(data), width, height);
    let qrPayload = null;
    if (qr) { qrPayload = qr.data; }
    else {
      const imgUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${rawKey}`;
      const ai = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 40,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Eres un lector de códigos QR.'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Devuélveme SOLO JSON {"qr":"<texto>"} sin explicar nada.' },
              {
                type: 'image_url',
                image_url: { url: imgUrl /* el mismo rawKey en S3 */ }
              }
            ]
          }
        ]
      });
      qrPayload = ai.choices?.[0]?.message?.content || null;
      console.log('[DBG] QR via OpenAI →', qrPayload);
    }

    log('facePNG bytes', facePNG.length);
    const faceKey = `faces/${msg.image.id}.png`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: faceKey, Body: facePNG, ContentType: 'image/png', ACL: 'public-read' }));
    console.log('[DBG] faceKey on S3 →', faceKey);

    // 4 openai
    let fullName = 'N/A';
    try {
      const imgUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${rawKey}`;
      const ai = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: 'Devuélveme SOLO JSON {"adultName":"<nombre completo>"}'
          },
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: imgUrl } }]
          }
        ],
        max_tokens: 120, response_format: { type: 'json_object' }
      });
      console.log('[OPENAI] response', ai);
      const payload = ai.choices?.[0]?.message?.content || '{}';
      fullName = JSON.parse(payload).adultName || 'N/A';
      console.log('[OPENAI] payload', payload);
    } catch (e) { log('openai fail', e.message); }
    log('fullName', fullName);
    console.log('[DBG] Value that will be placed in primaryFields →', fullName);

    // 5 certs
    let [wwdrPem, certPem, keyPem] = await Promise.all([
      getSecretValue(WWDR_CERT_NAME),
      getSecretValue(SIGNER_CERT_NAME),
      getSecretValue(SIGNER_KEY_NAME)
    ]);
    wwdrPem = unwrapPem(wwdrPem); certPem = unwrapPem(certPem); keyPem = ensureRsaPrivateKey(unwrapPem(keyPem));

    // 6 model
    const modelObj = {
      formatVersion: 1,
      // passStyle: 'eventTicket',
      passTypeIdentifier: APPLE_PASS_TYPE_ID,
      teamIdentifier: APPLE_TEAM_ID,
      organizationName: ORGANIZATION_NAME,
      description: 'Digital ID',
      serialNumber: `pass-${msg.image.id}-${Date.now()}`,
      foregroundColor: 'rgb(255,255,255)',
      backgroundColor: 'rgb(60,65,70)',
      labelColor: 'rgb(255,255,255)',
      generic: {                      // ← toda la info propia del pase
        headerFields: [{ key: 'header', label: 'Digital ID', value: '' }],
        primaryFields: [{ key: 'name', label: 'Full Name', value: fullName }],
        secondaryFields: qrPayload
          ? [{ key: 'qr', label: 'Código', value: qrPayload }]
          : []
        // backFields: [
        //   { key: 'date', label: 'Creado', value: new Date().toLocaleString('es-PE') },
        //   { key: 'id', label: 'Imagen ID', value: msg.image.id }
        // ]
      },
      barcodes: [{
        format: 'PKBarcodeFormatQR',
        message: qrPayload || `ID-${msg.image.id}`,
        messageEncoding: 'iso-8859-1'    // requerido
      }],
    };

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pk-'));
    const modelDir = `${tmp}.pass`;
    await fs.mkdir(modelDir);


    await fs.writeFile(path.join(modelDir, 'pass.json'), JSON.stringify(modelObj, null, 2));

    const assetsDir = path.join(__dirname, 'assets');   // <- carpeta con tus PNG
    const copies = [
      'icon.png', 'icon@2x.png',
      'logo.png', 'logo@2x.png',
      'thumbnail.png', 'thumbnail@2x.png',
      // 'strip.png', 'strip@2x.png'
    ];
    await Promise.all(
      copies.map(f =>
        fs.copyFile(path.join(assetsDir, f), path.join(modelDir, f))
      )
    );
    console.log('[DBG] Static images copied to modelDir →', copies);

    await fs.writeFile(path.join(modelDir, 'thumbnail.png'), facePNG);
    await fs.writeFile(path.join(modelDir, 'thumbnail@2x.png'), facePNG);

    console.log('DIR →', modelDir);
    console.log('FILES →', await fs.readdir(modelDir));
    // 7 generate pass
    const pass = await PKPass.from({ model: modelDir, certificates: { wwdr: wwdrPem, signerCert: certPem, signerKey: keyPem } });
    // console.log('[DBG] PKPass instance created. images API available →', !!pass.images);
    // console.log('pass.images →', typeof pass.images);      // debería imprimir 'object'
    // console.log('tiene add?  →', !!pass.images?.add);      // true
    // console.log('PKPass keys →', Object.keys(pass));   // debería incluir 'images'

    if (pass.images && typeof pass.images.add === 'function') {
      pass.images.add('thumbnail', facePNG);
      pass.images.add('thumbnail@2x', facePNG);

      pass.images.add('logo', await fs.readFile(logoPath));
      pass.images.add('logo@2x', await fs.readFile(logo2xPath));

      pass.images.add('icon', await fs.readFile(iconPath));
      pass.images.add('icon@2x', await fs.readFile(icon2xPath));
    } else {
      log('⚠️  esta build no soporta pass.images.add');
    }

    // console.log('entries →', pass.list());
    const passBuf = await pass.getAsBuffer();
    log('pkpass bytes', passBuf.length);
    // console.log('entries →', pass.list());   // debe listar strip.png, strip@2x.png, logo.png …

    const passKey = `passes/${msg.image.id}.pkpass`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: passKey, Body: passBuf, ContentType: 'application/vnd.apple.pkpass', ACL: 'public-read' }));
    const url = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${passKey}`;
    await sendText(sender, `¡Tu pase está listo! Descárgalo aquí: ${url}`);
    return { statusCode: 200, body: JSON.stringify({ passUrl: url }) };
  } catch (err) { log('fatal', err); await sendText(sender, 'Error generando tu pase'); return { statusCode: 500, body: err.message } }
}

module.exports = { handler };

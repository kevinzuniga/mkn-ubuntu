'use strict';

// ———‑‑ DEPENDENCIAS ———‑‑
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Jimp = require('jimp');
const { PKPass } = require('passkit-generator');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { RekognitionClient, DetectFacesCommand } = require('@aws-sdk/client-rekognition');
const OpenAI = require('openai');
const forge = require('node-forge');
const jsQR = require('jsqr');
const { getSecretValue } = require('./secrets');
const { execFile: execFileCallback } = require('child_process');
const { promisify } = require('util');
const execFile = promisify(execFileCallback);
const tmp = require('tmp-promise');
const FormData = require('form-data');

async function decodeQRWithZbar(buffer) {
  const { path, cleanup } = await tmp.file({ postfix: '.jpg' });
  await fs.writeFile(path, buffer);
  try {
    const { stdout } = await execFile('zbarimg', ['--quiet', '--raw', path]);
    return stdout.trim();        // devuelve sólo el payload
  } catch { return null; }
  finally { cleanup(); }
}

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

  // --- duplicado en memoria (durante vida del contenedor) ---
  if (processed.has(msg.id)) {
    log('skip duplicate in-memory', msg.id);
    return { statusCode: 200, body: 'dup-mem' };
  }

  log('incoming msg id', msg.id);

  // --- duplicado persistente (ya existe el .pkpass en S3) ---
  const passKey = `passes/${msg.image.id}.pkpass`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: passKey }));
    // Si no lanza, el objeto existe → saltamos
    log('pass already exists in S3, skipping generation for', msg.id);
    return { statusCode: 200, body: 'already processed' };
  } catch (err) {
    if (err.name !== 'NotFound') throw err; // error real de S3
    // Si es NotFound seguimos, porque no se ha generado aún
  }

  // Ahora sí lo marcamos en memoria para evitar re-entradas en esta ejecución
  processed.add(msg.id);
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
    let qrPayload = await decodeQRWithZbar(mediaBuf);
    if (!qrPayload) {
      const { path: tmpPath, cleanup } = await tmp.file({ postfix: '.jpg' });
      await fs.writeFile(tmpPath, mediaBuf);
      try {
        const { stdout } = await execFile('python3', ['scan_qr.py', tmpPath]);
        if (stdout) {
          qrPayload = stdout.trim();
          console.log('[DBG] pyzbar (Python) encontró QR:', qrPayload);
        } else {
          console.log('[DBG] pyzbar tampoco encontró QR');
        }
      } catch (err) {
        console.log('[DBG] error en scan_qr.py:', err.message);
      } finally {
        await cleanup();
      }
    } else {
      console.log('[DBG] ZBar encontró QR', qrPayload);
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
      passTypeIdentifier: APPLE_PASS_TYPE_ID,
      teamIdentifier: APPLE_TEAM_ID,
      organizationName: ORGANIZATION_NAME,
      description: 'Digital ID',
      serialNumber: `pass-${msg.image.id}-${Date.now()}`,

      // Colores para que se parezca al ejemplo (tono marrón‑dorado)
      foregroundColor: 'rgb(255,255,255)',        // valores en negro para el texto
      backgroundColor: 'rgb(199,154,110)',   // #C79A6E aprox
      labelColor: 'rgb(0,0,0)',

      generic: {
        // Encabezado con el logo: campo vacío para que no aparezca texto
        headerFields: [],

        // Solo mostramos el nombre
        primaryFields: [
          { key: 'name', label: 'FULL NAME', value: fullName }
        ],

        // Ningún otro campo visible
        secondaryFields: []
      },

      // El código QR sigue estando en la sección dedicada
      barcodes: [{
        format: 'PKBarcodeFormatQR',
        message: qrPayload || `ID-${msg.image.id}`,
        messageEncoding: 'iso-8859-1'
      }]
    };

    // 7 generate pass
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pk-'));
    const modelDir = `${tempDir}.pass`;
    await fs.mkdir(modelDir);


    await fs.writeFile(path.join(modelDir, 'pass.json'), JSON.stringify(modelObj, null, 2));

    const assetsDir = path.join(__dirname, 'assets');   // <- carpeta con tus PNG
    const copies = [
      'logo.png', 'logo@2x.png',        // usarás tu archivo IMG_4756.PNG renombrado a logo.png
      'icon.png', 'icon@2x.png',        // duplicados del logo para el ícono
      'thumbnail.png', 'thumbnail@2x.png'
    ];
    await Promise.all(
      copies.map(f =>
        fs.copyFile(path.join(assetsDir, f), path.join(modelDir, f))
      )
    );
    // si no tienes icon.png explícito, duplica el logo como icon
    // await fs.copyFile(path.join(assetsDir, 'logo.png'), path.join(modelDir, 'icon.png')).catch(()=>{});
    // await fs.copyFile(path.join(assetsDir, 'logo@2x.png'), path.join(modelDir, 'icon@2x.png')).catch(()=>{});
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
      // log('⚠️  esta build no soporta pass.images.add');
    }

    // console.log('entries →', pass.list());
    const passBuf = await pass.getAsBuffer();
    log('pkpass bytes', passBuf.length);
    // console.log('entries →', pass.list());   // debe listar strip.png, strip@2x.png, logo.png …

    /* --- subir el .pkpass --- */
    const passKey = `passes/${msg.image.id}.pkpass`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: passKey, Body: passBuf, ContentType: 'application/vnd.apple.pkpass', ACL: 'public-read' }));
    const url = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${passKey}`;
    /* --- enviar el mensaje con el archivo --- */
    await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: sender,
        type: 'document',
        document: {
          link: url,                      // ← aquí va el enlace público
          filename: 'wallet-pass.pkpass',
          caption: '¡Tu pase digital está listo! Descárgalo y ábrelo en Wallet 📲'
        }
      },
      { headers: { Authorization: `Bearer ${WA_CLOUD_API_ACCESS_TOKEN}` } }
    );
    
    // await sendText(sender, `¡Tu pase está listo! Descárgalo aquí: ${url}`);
    return { statusCode: 200, body: JSON.stringify({ passUrl: url }) };
  } catch (err) { log('fatal', err); await sendText(sender, 'Error generando tu pase'); return { statusCode: 500, body: err.message } }
}

module.exports = { handler };

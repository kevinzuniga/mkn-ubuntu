// secrets.js
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const fs = require('fs').promises;
const forge = require('node-forge');          // npm i node-forge

const client = new SecretsManagerClient({ region: process.env.AWS_REGION });

async function getSecretValue(id) {
  // Permite rutas locales también
  if (id.startsWith('/')) return fs.readFile(id, 'utf8');

  const { SecretString, SecretBinary } = await client.send(
    new GetSecretValueCommand({ SecretId: id })
  );
  let raw = SecretString ?? Buffer.from(SecretBinary, 'base64').toString('utf8');

  // Si viene como JSON (caso actual)
  try {
    const obj = JSON.parse(raw);
    raw = Object.values(obj)[0];       // toma el primer valor PEM
  } catch { /* no es JSON, deja igual */ }

  return raw.trim();
}

module.exports = { getSecretValue };
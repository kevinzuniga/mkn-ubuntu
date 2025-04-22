const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const region = process.env.AWS_REGION || 'us-east-1';
const secretsClient = new SecretsManagerClient({ region });

async function getSecretValue(secretName) {
  const command = new GetSecretValueCommand({ SecretId: secretName });
  const { SecretString, SecretBinary } = await secretsClient.send(command);
  return SecretString || Buffer.from(SecretBinary, 'base64');
}

module.exports = { getSecretValue };
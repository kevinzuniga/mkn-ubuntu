// test-secrets.js
const { getSecretValue } = require('./secrets');
(async () => {
//   console.log(await getSecretValue(process.env.WWDR_CERT_NAME));
  console.log(await getSecretValue(process.env.SIGNER_CERT_NAME));
//   console.log(await getSecretValue(process.env.SIGNER_KEY_NAME));
})();
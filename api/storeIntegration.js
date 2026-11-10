const crypto = require('node:crypto');
const { publicUrl } = require('./catalogSync');

function integrationKey() {
  const raw = process.env.STORE_INTEGRATION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error('Store credential storage is unavailable. Ask ECL to configure STORE_INTEGRATION_KEY (64 hexadecimal characters) on the API server.');
  return Buffer.from(raw, 'hex');
}

function integrationStorageReady() {
  return /^[a-f0-9]{64}$/i.test(process.env.STORE_INTEGRATION_KEY || '');
}

function validateStoreConnection(input) {
  const platform = input.platform;
  if (!['shopify', 'woocommerce', 'bigcommerce', 'amazon', 'wix', 'custom'].includes(platform)) throw new Error('Choose a supported store platform.');
  const raw = typeof input.domain === 'string' ? input.domain.trim() : '';
  if (!raw || raw.length > 500) throw new Error('Enter your HTTPS store address (maximum 500 characters).');
  const address = raw.includes('://') ? raw : `https://${raw}`;
  if (new URL(address).hash) throw new Error('Use an HTTPS store address without fragments.');
  const url = publicUrl(address);
  if (url.protocol !== 'https:' || url.search) throw new Error('Use an HTTPS store address without query parameters.');
  if (platform === 'shopify' && (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(url.hostname) || url.pathname !== '/')) {
    throw new Error('For Shopify, use your permanent store-name.myshopify.com domain, without a path.');
  }
  return { platform, domain: url.href.replace(/\/$/, '') };
}

function parseStoreConnection(raw) {
  if (!raw) return null;
  const parsed = JSON.parse(String(raw));
  const config = validateStoreConnection(parsed);
  return { ...config, updatedAt: String(parsed.updatedAt || '') };
}

function encryptStoreCredentials(credentials, clientId, config) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', integrationKey(), iv);
  cipher.setAAD(Buffer.from(`${clientId}\n${config.platform}\n${config.domain}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

function decryptStoreCredentials(encrypted, clientId, config) {
  const envelope = JSON.parse(encrypted);
  if (envelope.version !== 1) throw new Error('Unsupported credential encryption version.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', integrationKey(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(`${clientId}\n${config.platform}\n${config.domain}`));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
}

function readSubmittedCredentials(input, platform) {
  const keys = platform === 'woocommerce' ? ['consumerKey', 'consumerSecret']
    : platform === 'shopify' ? ['accessToken'] : ['accessToken', 'connectionDetails'];
  if (keys.some((key) => input[key] != null && typeof input[key] !== 'string')) {
    throw new Error('Credentials must be text values.');
  }
  const credentials = Object.fromEntries(keys.map((key) => [key, String(input[key] || '').trim()]));
  const supplied = keys.some((key) => credentials[key]);
  if (!supplied) return null;
  if (platform !== 'shopify' && platform !== 'woocommerce') {
    if (credentials.accessToken.length > 4096 || /[\r\n]/.test(credentials.accessToken)
      || credentials.connectionDetails.length > 5000) {
      throw new Error('Use a single-line API token/key of up to 4096 characters and connection details of up to 5000 characters.');
    }
    return Object.fromEntries(Object.entries(credentials).filter(([, value]) => value));
  }
  if (keys.some((key) => !credentials[key] || credentials[key].length > 4096 || /[\r\n]/.test(credentials[key]))) {
    throw new Error('Enter all required credentials for this platform (maximum 4096 characters each, without line breaks).');
  }
  if (platform === 'woocommerce' && (!/^ck_[a-f0-9]+$/i.test(credentials.consumerKey) || !/^cs_[a-f0-9]+$/i.test(credentials.consumerSecret))) {
    throw new Error('WooCommerce credentials must be a Consumer Key (ck_...) and Consumer Secret (cs_...).');
  }
  return credentials;
}

module.exports = { integrationStorageReady, validateStoreConnection, parseStoreConnection, encryptStoreCredentials, decryptStoreCredentials, readSubmittedCredentials };

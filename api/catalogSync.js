const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const cheerio = require('cheerio');
const ipaddr = require('ipaddr.js');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PRODUCTS = 50;

function publicAddress(address) {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  return parsed.range() === 'unicast';
}

function publicUrl(value, base) {
  const url = new URL(value, base);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))
    || hostname === 'localhost' || hostname.endsWith('.localhost')
    || (net.isIP(hostname) && !publicAddress(hostname))) {
    throw new Error('Use a public HTTP or HTTPS website URL without credentials or custom ports.');
  }
  url.hash = '';
  return url;
}

async function fetchPublicPage(value, { lookup = dns.lookup, request = (url, options, callback) =>
  (url.protocol === 'https:' ? https : http).request(url, options, callback) } = {}) {
  let url = publicUrl(value);
  const deadline = Date.now() + 12000;
  for (let hop = 0; hop <= 3; hop += 1) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let timer;
    let addresses;
    try {
      addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }]
        : await Promise.race([
          lookup(hostname, { all: true, verbatim: true }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Website lookup timed out. Use manual entry or retry.')), 3000);
          })
        ]);
    } finally {
      clearTimeout(timer);
    }
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
      throw new Error('This address is not a public website. Use a public product page or feed.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Website fetch timed out. You can enter the product manually.');
    const result = await new Promise((resolve, reject) => {
      const selected = addresses[0];
      // Pin the validated address in the socket lookup to prevent DNS rebinding.
      const req = request(url, {
        method: 'GET', agent: false,
        headers: { Accept: 'text/html, application/json, application/rss+xml, application/xml', 'Accept-Encoding': 'identity', 'User-Agent': 'ECL-Product-Import/1.0' },
        lookup: (_host, options, callback) => {
          if (options?.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        }
      }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.destroy();
          resolve({ redirect: response.headers.location });
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Website returned HTTP ${response.statusCode}. Try a public feed or enter the product manually.`));
          return;
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.resume();
          reject(new Error('This website requires a compressed response. Use a public JSON feed or manual entry.'));
          return;
        }
        if (Number(response.headers['content-length']) > MAX_BYTES) {
          response.destroy();
          reject(new Error('Feed is too large. Use a single product page or a smaller feed (maximum 2 MB).'));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            reject(new Error('Feed is too large. Use a single product page or a smaller feed (maximum 2 MB).'));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), url: url.href }));
      });
      const timer = setTimeout(() => req.destroy(new Error('Website fetch timed out. You can enter the product manually.')), Math.min(8000, remaining));
      req.on('error', reject);
      req.on('close', () => clearTimeout(timer));
      req.end();
    });
    if (!('redirect' in result)) return result;
    if (!result.redirect || hop === 3) throw new Error('Website redirected too many times or omitted its destination. Use the final public product URL.');
    url = publicUrl(result.redirect, url);
  }
}

function imageUrl(value, base) {
  if (!value) return '';
  try {
    return publicUrl(String(value).trim(), base).href;
  } catch {
    return '';
  }
}

function catalogFeedUrl(body, base) {
  const url = new URL(base);
  if (url.pathname !== '/') return '';
  const $ = cheerio.load(body);
  const feed = $('link[rel="alternate"]').toArray().find((element) =>
    /^(application\/(?:feed\+json|json|rss\+xml|atom\+xml))$/i.test($(element).attr('type') || ''));
  if (feed && $(feed).attr('href')) return publicUrl($(feed).attr('href'), base).href;
  if (/cdn\.shopify\.com|Shopify\.shop|shopify-section/i.test(body)) return new URL('/products.json?limit=50', base).href;
  return '';
}

function parseCatalog(body, base) {
  const $ = cheerio.load(body);
  const products = [];
  const add = (entry, fallback = {}) => {
    if (!entry || typeof entry !== 'object' || products.length >= MAX_PRODUCTS) return;
    const variant = Array.isArray(entry.variants) ? entry.variants[0] || {} : {};
    const rawImage = entry.image || entry.images?.[0] || entry.image_link || entry.thumbnail || fallback.image;
    const image = Array.isArray(rawImage) ? rawImage[0] : rawImage;
    const src = image && typeof image === 'object' ? image.url || image.src || image.contentUrl : image;
    const title = String(entry.name || entry.title || fallback.title || '').trim().slice(0, 500);
    if (!title) return;
    const bundled = entry.bundled ?? entry.isBundled ?? entry.is_bundled;
    const bundleQty = entry.bundleQty ?? entry.bundleQuantity ?? entry.bundle_quantity;
    const product = {
      title,
      sku: String(entry.sku || variant.sku || entry.gtin13 || entry.gtin12 || fallback.sku || '').trim().slice(0, 200),
      imageUrl: imageUrl(src, base),
      bundled: bundled === undefined ? '' : /^(true|yes|y|1)$/i.test(String(bundled)) ? 'Y' : 'N',
      bundleQty: Number.isSafeInteger(Number(bundleQty)) && Number(bundleQty) > 0 ? String(bundleQty) : ''
    };
    if (!products.some((item) => item.title === product.title && item.sku === product.sku)) products.push(product);
  };
  const visit = (data, depth = 0) => {
    if (depth > 10 || products.length >= MAX_PRODUCTS) return;
    const descend = (value) => visit(value, depth + 1);
    if (Array.isArray(data)) { data.slice(0, MAX_PRODUCTS).forEach(descend); return; }
    if (!data || typeof data !== 'object') return;
    if (data['@graph']) descend(data['@graph']);
    if (data.products) descend(data.products);
    if (data.items) descend(data.items);
    if (data.product) descend(data.product);
    const types = [].concat(data['@type'] || []);
    if (types.some((type) => /(?:^|\/)Product$/i.test(type))
      || (!types.length && !data.products && !data.items && !data.product && (data.name || data.title))) add(data);
    if (Array.isArray(data.itemListElement)) data.itemListElement.slice(0, MAX_PRODUCTS).forEach((item) => descend(item.item || item));
  };
  const trimmed = body.trim();
  if (/^[{[]/.test(trimmed)) {
    let data;
    try { data = JSON.parse(trimmed); } catch { throw new Error('The public feed is not valid JSON. You can enter the product manually.'); }
    visit(data);
  } else {
    $('script[type="application/ld+json"]').each((_index, script) => {
      let data;
      try { data = JSON.parse($(script).text()); } catch { return; }
      visit(data);
    });
    const xml = cheerio.load(body, { xml: true });
    xml('item, entry').slice(0, MAX_PRODUCTS).each((_index, item) => {
      const node = xml(item);
      const value = (...names) => names.map((name) => node.find(name.replace(':', '\\:')).first().text().trim()).find(Boolean);
      add({
        title: value('g:title', 'title'),
        sku: value('g:mpn', 'sku', 'g:id'),
        image_link: value('g:image_link', 'image_link') || node.find('enclosure[type^="image/"]').attr('url') || node.find('media\\:content').attr('url')
      });
    });
    if (!products.length) {
      const meta = (...names) => names.map((name) => $(`meta[property="${name}"], meta[name="${name}"]`).first().attr('content')).find(Boolean);
      add({ title: meta('og:title', 'twitter:title'), image: meta('og:image', 'twitter:image'), sku: meta('product:retailer_item_id', 'product:sku') });
    }
  }
  if (!products.length) throw new Error('No public product metadata found. Try a product page, JSON/RSS product feed, or enter details manually.');
  return { products, limit: MAX_PRODUCTS };
}

module.exports = { fetchPublicPage, parseCatalog, publicUrl, publicAddress, catalogFeedUrl };

const cheerio = require('cheerio');
const { publicUrl, fetchPublicPage } = require('./catalogSync');

function hexColor(value) {
  const text = String(value || '').trim();
  if (/^#[a-f0-9]{6}$/i.test(text)) return text.toUpperCase();
  if (/^#[a-f0-9]{3}$/i.test(text)) return `#${text.slice(1).split('').map(char => char + char).join('')}`.toUpperCase();
  const rgb = text.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
  if (rgb && rgb.slice(1).every(value => Number(value) <= 255)) {
    return `#${rgb.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  }
  return '';
}

function brandingUrl(value, base) {
  if (!value) return '';
  try { return publicUrl(String(value).trim(), base).href; } catch { return ''; }
}

function validateBranding(input) {
  const result = {};
  for (const key of ['websiteUrl', 'logoUrl']) {
    if (typeof input[key] !== 'string' || input[key].length > 2000) throw new Error('Website and logo URLs must be text of up to 2000 characters.');
    const raw = input[key].trim();
    const value = raw && key === 'websiteUrl' && !raw.includes('://') ? `https://${raw}` : raw;
    result[key] = value ? brandingUrl(value) : '';
    if (value && !result[key]) throw new Error('Use public HTTP or HTTPS website and logo URLs without credentials or custom ports.');
  }
  if (typeof input.accentColor !== 'string' || (input.accentColor.trim() && !/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(input.accentColor.trim()))) {
    throw new Error('Enter a hex accent color such as #2463EB, or leave it blank for the default.');
  }
  result.accentColor = hexColor(input.accentColor);
  return result;
}

function cssAccent(css) {
  const matches = String(css).matchAll(/--(?:(?:[a-z0-9]+-)*(?:primary|brand|accent)(?:-color|-main)?|color-(?:primary|brand|accent))\s*:\s*([^;}]+)/gi);
  for (const match of matches) {
    const color = hexColor(match[1]);
    if (color) return color;
  }
  return '';
}

function storefrontAccent($) {
  const scripts = $('script').toArray().map(element => $(element).text()).join('\n');
  // BigCommerce embeds theme settings in an escaped JSON string, not CSS variables.
  const metadata = scripts.replace(/\\"/g, '"');
  for (const key of ['button--primary-backgroundColor', 'color-primary', 'brandColor', 'accentColor']) {
    const match = metadata.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'i'));
    const color = hexColor(match?.[1]);
    if (color) return color;
  }
  return '';
}

function parseBranding(body, base) {
  const $ = cheerio.load(body);
  const candidates = [];
  const add = (value, priority, width = 0) => {
    const url = brandingUrl(value, base);
    if (url) candidates.push({ url, priority, width });
  };
  $('img').each((_, element) => {
    const image = $(element);
    if (!/logo/i.test(`${image.attr('alt') || ''} ${image.attr('class') || ''} ${image.attr('id') || ''} ${image.attr('src') || ''}`)) return;
    const srcset = image.attr('srcset') || '';
    for (const entry of srcset.split(',')) {
      const match = entry.trim().match(/^(\S+)\s+(\d+(?:\.\d+)?)(w|x)$/);
      if (match) add(match[1], 3, Number(match[2]) * (match[3] === 'x' ? 1000 : 1));
    }
    add(image.attr('src') || image.attr('data-src'), 3, Number(image.attr('width')) || 0);
  });
  $('link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]').each((_, element) =>
    add($(element).attr('href'), 2, parseInt($(element).attr('sizes'), 10) || 0));
  $('meta[property="og:image"], meta[property="og:image:secure_url"]').each((_, element) => add($(element).attr('content'), 1));
  candidates.sort((a, b) => b.priority - a.priority || b.width - a.width);
  const theme = $('meta[name="theme-color"]').toArray().map(element => hexColor($(element).attr('content'))).find(Boolean);
  const styles = $('style').toArray().map(element => $(element).text()).join('\n');
  const headerStyle = $('header, [role="banner"]').first().attr('style') || '';
  const headerColor = headerStyle.match(/background(?:-color)?\s*:\s*([^;]+)/i);
  const accentColor = storefrontAccent($) || theme || cssAccent(`${$('html').attr('style') || ''}\n${styles}`)
    || hexColor(headerColor?.[1]);
  const stylesheets = $('link[rel~="stylesheet"]').toArray()
    .sort((a, b) => Number($(b).is('[data-stencil-stylesheet]')) - Number($(a).is('[data-stencil-stylesheet]')))
    .map(element => brandingUrl($(element).attr('href'), base))
    .filter(url => url && !['fonts.googleapis.com', 'fonts.bunny.net'].includes(new URL(url).hostname)).slice(0, 2);
  return { logoUrl: candidates[0]?.url || '', accentColor: accentColor || '', stylesheets };
}

async function scrapeBranding(websiteUrl, fetchPage = fetchPublicPage) {
  const page = await fetchPage(websiteUrl);
  const branding = parseBranding(page.body, page.url);
  const warnings = [];
  if (!branding.accentColor) {
    for (const url of branding.stylesheets) {
      try {
        const css = await fetchPage(url);
        branding.accentColor = cssAccent(css.body);
        if (branding.accentColor) break;
      } catch {
        warnings.push('A stylesheet could not be inspected. Enter the accent color manually if needed.');
      }
    }
  }
  if (!branding.logoUrl) warnings.push('No public logo was found. Paste a logo image URL manually.');
  if (!branding.accentColor) warnings.push('No primary CSS/theme color was found. Paste a hex color manually.');
  return { websiteUrl, logoUrl: branding.logoUrl, accentColor: branding.accentColor, warnings };
}

module.exports = { hexColor, validateBranding, parseBranding, scrapeBranding };

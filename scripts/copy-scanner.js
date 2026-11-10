const fs = require('node:fs');
const path = require('node:path');

const source = path.dirname(require.resolve('html5-qrcode/package.json'));
const destination = path.join(__dirname, '..', 'frontend', 'vendor');
fs.mkdirSync(destination, { recursive: true });
for (const [file, output] of [['html5-qrcode.min.js', 'html5-qrcode.min.js'], ['LICENSE', 'html5-qrcode.LICENSE']]) {
  fs.copyFileSync(path.join(source, file), path.join(destination, output));
}

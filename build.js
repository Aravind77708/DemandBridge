require('./env');
const fs = require('fs');
const path = require('path');
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(path.join(publicDir, 'index.html')) || !fs.existsSync(path.join(publicDir, 'app.js'))) {
  throw new Error('Expected frontend files in public/.');
}
const apiBase = (process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
fs.writeFileSync(path.join(publicDir, 'config.js'), `window.DEMANDBRIDGE_API_BASE = ${JSON.stringify(apiBase)};\n`);
console.log(`Frontend configuration generated (${apiBase || 'same-origin API'}).`);

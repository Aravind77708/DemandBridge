require('./env');
const fs = require('fs');
const path = require('path');
const publicDir = path.join(__dirname, 'public');
const PRODUCTION_API_BASE_URL = 'https://demandbridge.onrender.com';
if (!fs.existsSync(path.join(publicDir, 'index.html')) || !fs.existsSync(path.join(publicDir, 'app.js'))) {
  throw new Error('Expected frontend files in public/.');
}
const apiBase = (process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
const isVercelProduction = process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production';
if (isVercelProduction && apiBase !== PRODUCTION_API_BASE_URL) {
  throw new Error(`Production Vercel builds require API_BASE_URL=${PRODUCTION_API_BASE_URL}; received ${apiBase || '(empty)'}.`);
}

const configPath = path.join(publicDir, 'config.js');
const configSource = `window.DEMANDBRIDGE_API_BASE = ${JSON.stringify(apiBase)};\n`;
fs.writeFileSync(configPath, configSource);
const generatedSource = fs.readFileSync(configPath, 'utf8');
const assignment = /^window\.DEMANDBRIDGE_API_BASE = (.+);\s*$/m.exec(generatedSource);
const generatedApiBase = assignment ? JSON.parse(assignment[1]) : null;
if (generatedApiBase !== apiBase || (isVercelProduction && generatedApiBase !== PRODUCTION_API_BASE_URL)) {
  throw new Error('Generated frontend config does not contain the configured API_BASE_URL.');
}
console.log(`Frontend configuration generated (${apiBase || 'same-origin API'}).`);

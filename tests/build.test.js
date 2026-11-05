const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const expectedApiBase = 'https://demandbridge.onrender.com';

function runProductionBuild(apiBase) {
  return spawnSync(process.execPath, ['build.js'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, VERCEL: '1', VERCEL_ENV: 'production', API_BASE_URL: apiBase },
  });
}

test('local build retains the same-origin API fallback when API_BASE_URL is unset', () => {
  const result = spawnSync(process.execPath, ['build.js'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, VERCEL: '0', VERCEL_ENV: 'development', API_BASE_URL: '' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(path.join(root, 'public', 'config.js'), 'utf8'), 'window.DEMANDBRIDGE_API_BASE = "";\n');
});

test('Vercel production build verifies and generates the configured Render API base', () => {
  const result = runProductionBuild(expectedApiBase);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.readFileSync(path.join(root, 'public', 'config.js'), 'utf8'),
    `window.DEMANDBRIDGE_API_BASE = ${JSON.stringify(expectedApiBase)};\n`,
  );
});

test('Vercel production build rejects missing or incorrect API_BASE_URL values', () => {
  for (const apiBase of ['', 'https://wrong-backend.example']) {
    const result = runProductionBuild(apiBase);
    assert.notEqual(result.status, 0, `unexpected success for API_BASE_URL=${apiBase || '(empty)'}`);
    assert.match(result.stderr, /Production Vercel builds require API_BASE_URL/);
  }
});

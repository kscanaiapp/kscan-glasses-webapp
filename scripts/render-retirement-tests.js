import fs from 'node:fs';

const activeConfig = [
  '.env.example',
  'vercel.json',
].map((file) => [file, fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')]);
const apiSource = fs.readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');

for (const [file, content] of activeConfig) {
  if (content.includes('kscan-app-1.onrender.com')) {
    throw new Error(`${file} reintroduces the retired Render host`);
  }
}
if (!apiSource.includes('VITE_ENABLE_PRIVATE_LIVE_ANALYZE')) {
  throw new Error('private-live fail-closed gate is missing');
}
if (!apiSource.includes('LIVE_DISABLED')) {
  throw new Error('live-disabled response is missing');
}

console.log('PASS | retired Render caller guard');

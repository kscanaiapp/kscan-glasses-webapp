import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const srcDir = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const destDir = path.join(root, 'public', 'mediapipe', 'wasm');

const files = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

function fail(message) {
  console.error(`[copy:wasm] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(srcDir)) {
  fail(`Source directory missing: ${srcDir}`);
}

fs.mkdirSync(destDir, { recursive: true });

for (const file of files) {
  const src = path.join(srcDir, file);
  const dest = path.join(destDir, file);
  if (!fs.existsSync(src)) {
    fail(`Missing source file: ${src}`);
  }
  fs.copyFileSync(src, dest);
}

console.log('[copy:wasm] MediaPipe WASM assets copied successfully.');

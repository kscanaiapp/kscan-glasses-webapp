import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const modelPath = path.join(root, 'public', 'models', 'blaze_face_full_range.tflite');
const wasmDir = path.join(root, 'public', 'mediapipe', 'wasm');

const wasmFiles = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

function sizeOf(filePath) {
  return fs.statSync(filePath).size;
}

function fail(message) {
  console.error(`[verify:models] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(modelPath)) {
  fail(
    `Missing model: ${modelPath}\n` +
    'Install it from official MediaPipe sample source:\n' +
    'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite'
  );
}

if (sizeOf(modelPath) <= 0) {
  fail(`Model file is empty: ${modelPath}`);
}

if (!fs.existsSync(wasmDir)) {
  fail(`Missing WASM directory: ${wasmDir}`);
}

for (const file of wasmFiles) {
  const fullPath = path.join(wasmDir, file);
  if (!fs.existsSync(fullPath)) {
    fail(`Missing WASM runtime file: ${fullPath}`);
  }
  if (sizeOf(fullPath) <= 0) {
    fail(`Empty WASM runtime file: ${fullPath}`);
  }
}

console.log('[verify:models] Model and MediaPipe WASM assets verified.');

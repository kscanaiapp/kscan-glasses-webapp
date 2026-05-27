import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite';
const root = process.cwd();
const destDir = path.join(root, 'public', 'models');
const destFile = path.join(destDir, 'blaze_face_full_range.tflite');

function fail(message) {
  console.error(`[download:model] ${message}`);
  process.exit(1);
}

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }

      const file = fs.createWriteStream(outPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    await download(MODEL_URL, destFile);

    const size = fs.statSync(destFile).size;
    if (size <= 0) {
      fail('Downloaded model is empty.');
    }

    console.log(`[download:model] Downloaded blaze_face_full_range.tflite (${size} bytes).`);
  } catch (error) {
    fail(error.message);
  }
})();

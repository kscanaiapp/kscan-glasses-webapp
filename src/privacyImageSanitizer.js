// Privacy sanitizer for on-device face masking before backend upload.
// No face metadata is persisted, logged, or exposed outside this module.
//
// Pipeline position (enforced by scanPipeline.js + tests): the sanitizer
// ALWAYS runs between capture and analyzeImage. The raw capture string is
// never sent to the backend.
//
// What sanitization does:
//   1. Decodes the capture and redraws it onto a fresh canvas — this strips
//      EXIF/GPS/metadata and converts any input format (incl. PNG) to JPEG.
//   2. Downsamples to maxSide (800px default).
//   3. Runs the MediaPipe BlazeFace detector (lazy-loaded, local WASM/model
//      assets) and solid-masks every detected face region with margin.
//   4. Re-encodes as JPEG. If output exceeds MAX_SANITIZED_OUTPUT_CHARS the
//      sanitizer retries at lower quality, then fails closed.
//
// Failure mode (conservative, documented in README/QA_REPORT): any decode,
// detector-init, or detection failure throws SanitizerError and the upload
// is BLOCKED. We never fall back to uploading the unsanitized capture.

const DEFAULT_OPTIONS = {
  maxSide: 800,
  detectionMaxSide: 1024,
  margin: 0.25,
  jpegQuality: 0.8,
};

// ~1MB cap on the sanitized data URL (chars). Documented in README.
export const MAX_SANITIZED_OUTPUT_CHARS = 1024 * 1024;
const FALLBACK_JPEG_QUALITY = 0.6;

const VISION_WASM_BASE_PATH = '/mediapipe/wasm';
const FACE_MODEL_PATH = '/models/blaze_face_full_range.tflite';

export const SANITIZER_ERROR_CODES = {
  INVALID_IMAGE: 'INVALID_IMAGE',
  SANITIZER_MODEL_MISSING: 'SANITIZER_MODEL_MISSING',
  FACE_DETECTION_FAILED: 'FACE_DETECTION_FAILED',
  CANVAS_FAILED: 'CANVAS_FAILED',
  SANITIZER_IN_PROGRESS: 'SANITIZER_IN_PROGRESS',
  OUTPUT_TOO_LARGE: 'OUTPUT_TOO_LARGE',
};

export class SanitizerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SanitizerError';
    this.code = code;
  }
}

let inProgress = false;
let detector = null;
let detectorPromise = null;
let maskEngineOverrideForTests = null;

/**
 * DEV/TEST ONLY hook: inject a mock detector ({ detect(canvas) => result }).
 * Lets the simulator and tests exercise zero/one/multi face-region paths
 * without committing real face imagery. Pass null to clear.
 */
export function __setMaskEngineForTests(detectorLike) {
  maskEngineOverrideForTests = detectorLike || null;
}

function toDataUrl(input) {
  if (typeof input !== 'string' || input.trim().length < 16) {
    throw new SanitizerError(SANITIZER_ERROR_CODES.INVALID_IMAGE, 'Invalid image input');
  }

  const trimmed = input.trim();
  if (trimmed.startsWith('data:image/')) return trimmed;
  return `data:image/jpeg;base64,${trimmed}`;
}

async function decodeImage(dataUrl) {
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();

    if (typeof createImageBitmap === 'function') {
      return await createImageBitmap(blob);
    }

    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode image')); // no payload logging
      img.src = dataUrl;
    });
  } catch {
    throw new SanitizerError(SANITIZER_ERROR_CODES.INVALID_IMAGE, 'Unable to decode image');
  }
}

function scaleSize(width, height, maxSide) {
  const longest = Math.max(width, height) || 1;
  const ratio = Math.min(1, maxSide / longest);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

async function ensureFaceDetector() {
  if (maskEngineOverrideForTests) return maskEngineOverrideForTests;
  if (detector) return detector;
  if (detectorPromise) return detectorPromise;

  detectorPromise = (async () => {
    try {
      const modelHead = await fetch(FACE_MODEL_PATH, { method: 'HEAD' });
      if (!modelHead.ok) {
        throw new SanitizerError(
          SANITIZER_ERROR_CODES.SANITIZER_MODEL_MISSING,
          'Face detector model is missing.',
        );
      }

      const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const vision = await FilesetResolver.forVisionTasks(VISION_WASM_BASE_PATH);
      detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: FACE_MODEL_PATH,
        },
        runningMode: 'IMAGE',
      });

      return detector;
    } catch (error) {
      detector = null;
      if (error instanceof SanitizerError) throw error;
      throw new SanitizerError(
        SANITIZER_ERROR_CODES.FACE_DETECTION_FAILED,
        'Face detector failed to initialize.',
      );
    } finally {
      detectorPromise = null;
    }
  })();

  return detectorPromise;
}

function clampRect(x, y, width, height, maxWidth, maxHeight) {
  const nx = Math.max(0, x);
  const ny = Math.max(0, y);
  const nRight = Math.min(maxWidth, x + width);
  const nBottom = Math.min(maxHeight, y + height);

  return {
    x: nx,
    y: ny,
    width: Math.max(0, nRight - nx),
    height: Math.max(0, nBottom - ny),
  };
}

function maskFaceBoxes(ctx, boxes, margin, canvasWidth, canvasHeight) {
  ctx.fillStyle = '#000000';

  for (const box of boxes) {
    const expandedX = box.x - margin * box.width;
    const expandedY = box.y - margin * box.height;
    const expandedW = box.width * (1 + 2 * margin);
    const expandedH = box.height * (1 + 2 * margin);

    const clamped = clampRect(expandedX, expandedY, expandedW, expandedH, canvasWidth, canvasHeight);
    if (clamped.width > 0 && clamped.height > 0) {
      ctx.fillRect(clamped.x, clamped.y, clamped.width, clamped.height);
    }
  }
}

function extractBoxes(result, scaleX, scaleY) {
  const detections = Array.isArray(result?.detections) ? result.detections : [];

  return detections
    .map((detection) => {
      const bb = detection?.boundingBox;
      if (!bb) return null;

      const x = Number.isFinite(bb.originX) ? bb.originX : 0;
      const y = Number.isFinite(bb.originY) ? bb.originY : 0;
      const width = Number.isFinite(bb.width) ? bb.width : 0;
      const height = Number.isFinite(bb.height) ? bb.height : 0;

      if (width <= 0 || height <= 0) return null;

      return {
        x: x * scaleX,
        y: y * scaleY,
        width: width * scaleX,
        height: height * scaleY,
      };
    })
    .filter(Boolean);
}

function encodeWithinLimit(canvas, preferredQuality) {
  const first = canvas.toDataURL('image/jpeg', preferredQuality);
  if (first.length <= MAX_SANITIZED_OUTPUT_CHARS) return first;

  // One lower-quality retry, then fail closed. Never upload oversized output.
  const second = canvas.toDataURL('image/jpeg', FALLBACK_JPEG_QUALITY);
  if (second.length <= MAX_SANITIZED_OUTPUT_CHARS) return second;

  throw new SanitizerError(
    SANITIZER_ERROR_CODES.OUTPUT_TOO_LARGE,
    'Sanitized image exceeds the upload size limit.',
  );
}

export async function sanitizeImageBeforeUpload(base64Image, options = {}) {
  if (inProgress) {
    throw new SanitizerError(
      SANITIZER_ERROR_CODES.SANITIZER_IN_PROGRESS,
      'Sanitizer is already running.',
    );
  }

  inProgress = true;

  const config = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  let sourceImage = null;
  let canvas = null;
  let detectCanvas = null;

  try {
    const dataUrl = toDataUrl(base64Image);
    sourceImage = await decodeImage(dataUrl);

    const width = sourceImage.naturalWidth || sourceImage.videoWidth || sourceImage.width;
    const height = sourceImage.naturalHeight || sourceImage.videoHeight || sourceImage.height;

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new SanitizerError(SANITIZER_ERROR_CODES.INVALID_IMAGE, 'Invalid image dimensions');
    }

    const outputSize = scaleSize(width, height, config.maxSide);
    canvas = document.createElement('canvas');
    canvas.width = outputSize.width;
    canvas.height = outputSize.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new SanitizerError(SANITIZER_ERROR_CODES.CANVAS_FAILED, 'Canvas context unavailable');
    }

    ctx.drawImage(sourceImage, 0, 0, outputSize.width, outputSize.height);

    const detectSize = scaleSize(outputSize.width, outputSize.height, config.detectionMaxSide);
    detectCanvas = document.createElement('canvas');
    detectCanvas.width = detectSize.width;
    detectCanvas.height = detectSize.height;

    const detectCtx = detectCanvas.getContext('2d');
    if (!detectCtx) {
      throw new SanitizerError(SANITIZER_ERROR_CODES.CANVAS_FAILED, 'Detection canvas unavailable');
    }

    detectCtx.drawImage(canvas, 0, 0, detectSize.width, detectSize.height);

    const faceDetector = await ensureFaceDetector();

    let detectionResult;
    try {
      detectionResult = faceDetector.detect(detectCanvas);
    } catch {
      throw new SanitizerError(
        SANITIZER_ERROR_CODES.FACE_DETECTION_FAILED,
        'Face detection failed at runtime.',
      );
    }

    const scaleX = outputSize.width / detectSize.width;
    const scaleY = outputSize.height / detectSize.height;
    const boxes = extractBoxes(detectionResult, scaleX, scaleY);

    if (boxes.length > 0) {
      maskFaceBoxes(ctx, boxes, config.margin, outputSize.width, outputSize.height);
    }

    return encodeWithinLimit(canvas, config.jpegQuality);
  } finally {
    if (sourceImage && typeof sourceImage.close === 'function') {
      sourceImage.close();
    }

    sourceImage = null;
    canvas = null;
    detectCanvas = null;
    inProgress = false;
  }
}

export function mapSanitizerErrorToUserMessage(error) {
  if (error instanceof SanitizerError && error.code === SANITIZER_ERROR_CODES.OUTPUT_TOO_LARGE) {
    return 'Image too large. Try again.';
  }
  if (error instanceof SanitizerError && (
    error.code === SANITIZER_ERROR_CODES.FACE_DETECTION_FAILED
    || error.code === SANITIZER_ERROR_CODES.SANITIZER_MODEL_MISSING
  )) {
    return "We couldn't verify this image is safe to upload. Please try again.";
  }
  return 'Privacy scan failed. Try again.';
}

export function teardownSanitizer() {
  if (detector && typeof detector.close === 'function') {
    detector.close();
  }
  detector = null;
  detectorPromise = null;
}

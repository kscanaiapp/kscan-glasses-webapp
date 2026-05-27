function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Unable to decode captured image'));
    img.src = dataUrl;
  });
}

export function detectFaces() {
  return [];
}

export function maskFaceRegions(ctx, faces, scale) {
  for (const face of faces) {
    const x = Math.max(0, Math.floor(face.x * scale.x));
    const y = Math.max(0, Math.floor(face.y * scale.y));
    const w = Math.max(1, Math.floor(face.width * scale.x));
    const h = Math.max(1, Math.floor(face.height * scale.y));
    ctx.fillStyle = '#000000';
    ctx.fillRect(x, y, w, h);
  }
}

export async function sanitizeImageBeforeUpload(base64Image) {
  if (typeof base64Image !== 'string' || base64Image.length < 32) {
    throw new Error('Invalid image input for sanitizer');
  }

  const image = await loadImage(base64Image);
  const longest = Math.max(image.width, image.height) || 1;
  const ratio = Math.min(1, 800 / longest);
  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to initialize sanitizer canvas');

  // Redraw and re-encode to drop source metadata (EXIF/GPS/etc.) before upload.
  ctx.drawImage(image, 0, 0, width, height);

  // Production privacy requirement: detected faces must be masked before upload.
  // This scaffold has a deterministic mask hook; integrate a detector (MediaPipe/TF) next.
  const faces = detectFaces(canvas);
  if (Array.isArray(faces) && faces.length) {
    maskFaceRegions(ctx, faces, {
      x: width / image.width,
      y: height / image.height,
    });
  }

  return canvas.toDataURL('image/jpeg', 0.8);
}
function isMetaRuntime() {
  return window !== window.parent;
}

function isMockEnabled() {
  return String(import.meta.env.VITE_MOCK_DAT || '').toLowerCase() === 'true' && !import.meta.env.PROD;
}

function bridgeAvailable() {
  return Boolean(window.parent && typeof window.parent.postMessage === 'function' && typeof window.addEventListener === 'function');
}

function generateMockImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');

  if (!ctx) throw new Error('Unable to create mock canvas');

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#00E5FF';
  ctx.fillRect(60, 120, 480, 280);
  ctx.fillStyle = '#001A22';
  ctx.font = 'bold 42px sans-serif';
  ctx.fillText('K Scan Mock', 130, 260);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '24px sans-serif';
  ctx.fillText(new Date().toISOString().slice(0, 19), 145, 320);

  return canvas.toDataURL('image/jpeg', 0.9);
}

export async function capturePhoto() {
  if (isMockEnabled()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return generateMockImage();
  }

  if (!isMetaRuntime() || !bridgeAvailable()) {
    throw new Error('DAT bridge unavailable and mock capture is disabled');
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Capture timeout after 10 seconds'));
    }, 10000);

    function cleanup() {
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    }

    function onMessage(event) {
      const payload = event.data || {};

      if (payload.type === 'CAPTURE_RESPONSE') {
        const image = payload?.data?.base64Image;
        cleanup();
        if (typeof image === 'string' && image.length > 16) resolve(image);
        else reject(new Error('Invalid CAPTURE_RESPONSE payload'));
      }

      if (payload.type === 'photo-captured') {
        const image = payload?.base64;
        cleanup();
        if (typeof image === 'string' && image.length > 16) resolve(image);
        else reject(new Error('Invalid photo-captured payload'));
      }

      if (payload.type === 'CAPTURE_ERROR') {
        cleanup();
        reject(new Error(payload?.message || 'Capture failed'));
      }
    }

    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'REQUEST_CAPTURE' }, '*');
  });
}

export function getDatStatus() {
  if (isMockEnabled()) return 'DAT: mock';
  if (isMetaRuntime() && bridgeAvailable()) return 'DAT: ready';
  return 'DAT: unavailable';
}

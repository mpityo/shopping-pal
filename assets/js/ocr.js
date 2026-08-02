/**
 * Optional photo OCR for paper receipts.
 *
 * The rest of this app has no dependencies and works offline, and that is
 * worth keeping. So the OCR engine is not part of the shell: it is fetched
 * from a CDN the first time someone actually photographs a receipt, and never
 * otherwise. Nothing here runs — or is even downloaded — unless asked for.
 *
 * The image never leaves the device. Recognition happens in a worker in the
 * browser; no receipt is uploaded anywhere, and nothing is committed to the
 * repo.
 *
 * Be realistic about accuracy: crumpled thermal paper photographed at an angle
 * reads poorly. Pasting the text from an emailed or in-app receipt is far more
 * reliable, which is why that is the primary path and this is the fallback.
 */

const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

let loading = null;

function loadEngine() {
  if (globalThis.Tesseract) return Promise.resolve(globalThis.Tesseract);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CDN;
    script.async = true;
    script.onload = () =>
      globalThis.Tesseract
        ? resolve(globalThis.Tesseract)
        : reject(new Error('The OCR library loaded but did not initialise.'));
    script.onerror = () =>
      reject(
        new Error(
          'Could not download the OCR library. It needs a connection the first ' +
            'time — after that it is cached. Pasting the receipt text always works.',
        ),
      );
    document.head.append(script);
  }).catch((err) => {
    loading = null;
    throw err;
  });

  return loading;
}

export function isAvailable() {
  return typeof document !== 'undefined';
}

/**
 * Read text out of a receipt image.
 * `onProgress` receives 0–1 so the caller can show something during what is a
 * genuinely slow operation on a phone.
 */
export async function readImage(file, onProgress = () => {}) {
  const Tesseract = await loadEngine();
  const { data } = await Tesseract.recognize(file, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress(m.progress);
      }
    },
  });
  return data?.text ?? '';
}

/**
 * Downscale before recognition. Phone photos are far larger than OCR needs,
 * and full-resolution input makes it slow enough that people give up.
 */
export function prepareImage(file, maxEdge = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      if (scale === 1) return resolve(file);

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob ?? file), 'image/jpeg', 0.85);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image.'));
    };
    img.src = url;
  });
}

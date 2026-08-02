/**
 * Reading receipts out of PDFs.
 *
 * Emailed Publix and Walmart receipts are text PDFs, so the text layer can be
 * extracted directly and fed to the same parser the paste path uses. Scanned
 * or photographed PDFs have no text layer; those are rendered to a canvas and
 * handed to OCR instead.
 *
 * Like the OCR engine, the PDF library is fetched only when a PDF is actually
 * opened. The app's shell stays dependency-free and works offline.
 */

const PDF_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';
const PDF_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';

let loading = null;

function loadPdfjs() {
  if (loading) return loading;
  loading = import(/* webpackIgnore: true */ PDF_CDN)
    .then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
      return lib;
    })
    .catch((err) => {
      loading = null;
      throw new Error(
        `Could not load the PDF reader (${err.message}). It needs a connection the ` +
          'first time. You can also open the PDF and paste its text instead.',
      );
    });
  return loading;
}

/**
 * Rebuild visual lines from PDF text fragments.
 *
 * A PDF has no concept of lines — just glyph runs at coordinates. Receipts
 * depend on layout (the price sits at the right-hand end of its row), so
 * fragments are grouped by baseline and ordered left to right, with a wide gap
 * rendered as whitespace to keep the price at the end where the parser looks
 * for it.
 *
 * Exported for testing: this is the part that decides whether the parser sees
 * a receipt or confetti.
 */
export function itemsToLines(items, yTolerance = 3) {
  const rows = [];

  for (const item of items) {
    const text = item.str;
    if (!text || !text.trim()) continue;
    const x = item.transform?.[4] ?? 0;
    const y = item.transform?.[5] ?? 0;

    // PDF y grows upward, so a "later" row has a smaller y.
    let row = rows.find((r) => Math.abs(r.y - y) <= yTolerance);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, text, width: item.width ?? 0 });
  }

  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => {
      const parts = row.parts.sort((a, b) => a.x - b.x);
      let line = '';
      let cursorX = null;
      for (const part of parts) {
        if (cursorX !== null) {
          const gap = part.x - cursorX;
          // A visible gap is column separation, not a word space. Two spaces
          // keeps the trailing amount detectable as a separate field.
          line += gap > 8 ? '  ' : gap > 0.5 ? ' ' : '';
        }
        line += part.text;
        cursorX = part.x + (part.width || part.text.length * 4);
      }
      return line.trimEnd();
    })
    .filter((line) => line.trim());
}

/** How much of a document looks like real text rather than an empty layer. */
function textDensity(pagesText) {
  const joined = pagesText.join('\n');
  return joined.replace(/\s/g, '').length;
}

/**
 * Extract text from a PDF. Falls back to OCR when there is no text layer,
 * which is what a scanned or photographed receipt looks like.
 */
export async function readPdf(file, { onProgress = () => {}, ocr = null } = {}) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    onProgress((n - 1) / doc.numPages, `Reading page ${n} of ${doc.numPages}…`);
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(itemsToLines(content.items).join('\n'));
  }

  // Fewer than ~40 characters across the whole document means the text layer
  // is effectively empty — an image-only PDF.
  if (textDensity(pages) >= 40) {
    return { text: pages.join('\n'), scanned: false };
  }

  if (!ocr) {
    throw new Error(
      'That PDF has no text in it — it is a scan or a photo. Photograph it or paste the text instead.',
    );
  }

  onProgress(0, 'No text found; reading it as an image…');
  const ocrPages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    ocrPages.push(
      await ocr.readImage(blob, (p) =>
        onProgress((n - 1 + p) / doc.numPages, `Reading page ${n} as an image…`),
      ),
    );
  }
  return { text: ocrPages.join('\n'), scanned: true };
}

export function isPdf(file) {
  return file?.type === 'application/pdf' || /\.pdf$/i.test(file?.name ?? '');
}

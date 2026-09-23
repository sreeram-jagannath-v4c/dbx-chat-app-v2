import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { buildPreviewUrl, type PreviewDocument } from './document-preview';

// pdf.js is loaded lazily so it stays out of the main bundle.
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | undefined;

function loadPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  });
  return pdfjsPromise;
}

// One loaded document per file, one rendered image per file + page.
const documents = new Map<string, Promise<PDFDocumentProxy>>();
const thumbnails = new Map<string, Promise<string>>();

function loadDocument(volumePath: string): Promise<PDFDocumentProxy> {
  let promise = documents.get(volumePath);
  if (!promise) {
    promise = loadPdfjs().then(
      (pdfjs) =>
        pdfjs.getDocument({
          url: buildPreviewUrl({ volumePath, fileName: '', originalHref: '' }),
          withCredentials: true,
          // Fetch only the byte ranges needed to render the requested page.
          disableAutoFetch: true,
          disableStream: true,
        }).promise,
    );
    // Allow a retry after a failed load.
    promise.catch(() => documents.delete(volumePath));
    documents.set(volumePath, promise);
  }
  return promise;
}

async function renderPage(
  doc: PreviewDocument,
  width: number,
): Promise<string> {
  const pdf = await loadDocument(doc.volumePath);
  const pageNumber = Math.min(Math.max(doc.page ?? 1, 1), pdf.numPages);
  const page = await pdf.getPage(pageNumber);

  const scale =
    (width * (window.devicePixelRatio || 1)) /
    page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  try {
    await page.render({ canvas, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw new Error('Failed to encode thumbnail');
    return URL.createObjectURL(blob);
  } finally {
    page.cleanup();
  }
}

/**
 * Renders the document's page to an image and returns an object URL.
 * Results are cached for the lifetime of the page.
 */
export function getPdfThumbnail(
  doc: PreviewDocument,
  width = 160,
): Promise<string> {
  const key = `${doc.volumePath}#${doc.page ?? 1}@${width}`;
  let promise = thumbnails.get(key);
  if (!promise) {
    promise = renderPage(doc, width);
    promise.catch(() => thumbnails.delete(key));
    thumbnails.set(key, promise);
  }
  return promise;
}

import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { buildPreviewUrl, type PreviewDocument } from './document-preview';

type Pdfjs = typeof import('pdfjs-dist');

// pdf.js is loaded lazily so it stays out of the main bundle. All documents
// share one worker instead of each starting its own.
let pdfjsPromise: Promise<{ pdfjs: Pdfjs; worker: PDFWorker }> | undefined;

function loadPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return { pdfjs, worker: new pdfjs.PDFWorker() };
  });
  return pdfjsPromise;
}

/**
 * Starts loading pdf.js and its worker ahead of the first thumbnail, so they
 * download in parallel with the first document.
 */
export function preloadPdfjs(): void {
  loadPdfjs().catch((error) => {
    pdfjsPromise = undefined;
    console.error('Failed to load pdf.js:', error);
  });
}

// Larger than pdf.js's 64 KB default: fewer round trips through the app.
const RANGE_CHUNK_SIZE = 256 * 1024;

export interface PdfThumbnail {
  src: string;
  /** Page width / height; above 1 for landscape pages such as slides. */
  aspectRatio: number;
}

// Landscape pages are shown in wider cards, so render them at more pixels.
const LANDSCAPE_WIDTH_FACTOR = 1.75;

// One loaded document per file, one rendered image per file + page.
const documents = new Map<string, Promise<PDFDocumentProxy>>();
const thumbnails = new Map<string, Promise<PdfThumbnail>>();

function loadDocument(volumePath: string): Promise<PDFDocumentProxy> {
  let promise = documents.get(volumePath);
  if (!promise) {
    promise = loadPdfjs().then(
      ({ pdfjs, worker }) =>
        pdfjs.getDocument({
          url: buildPreviewUrl({ volumePath, fileName: '', originalHref: '' }),
          withCredentials: true,
          worker,
          // Fetch only the byte ranges needed to render the requested page.
          disableAutoFetch: true,
          disableStream: true,
          rangeChunkSize: RANGE_CHUNK_SIZE,
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
): Promise<PdfThumbnail> {
  const pdf = await loadDocument(doc.volumePath);
  const pageNumber = Math.min(Math.max(doc.page ?? 1, 1), pdf.numPages);
  const page = await pdf.getPage(pageNumber);

  const baseViewport = page.getViewport({ scale: 1 });
  const aspectRatio = baseViewport.width / baseViewport.height;
  const targetWidth = aspectRatio > 1 ? width * LANDSCAPE_WIDTH_FACTOR : width;
  const scale =
    (targetWidth * (window.devicePixelRatio || 1)) / baseViewport.width;
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
    return { src: URL.createObjectURL(blob), aspectRatio };
  } finally {
    page.cleanup();
  }
}

/**
 * Renders the document's page to an image and returns an object URL along
 * with the page's aspect ratio. Results are cached for the lifetime of the
 * page.
 */
export function getPdfThumbnail(
  doc: PreviewDocument,
  width = 160,
): Promise<PdfThumbnail> {
  const key = `${doc.volumePath}#${doc.page ?? 1}@${width}`;
  let promise = thumbnails.get(key);
  if (!promise) {
    promise = renderPage(doc, width);
    promise.catch(() => thumbnails.delete(key));
    thumbnails.set(key, promise);
  }
  return promise;
}

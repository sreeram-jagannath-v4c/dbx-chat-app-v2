export interface PreviewDocument {
  /** UC Volume path, e.g. /Volumes/catalog/schema/volume/file.pdf */
  volumePath: string;
  fileName: string;
  /** 1-based page number from the link's `#page=N` fragment, if any. */
  page?: number;
  originalHref: string;
}

// Matches Databricks Files API URLs, both the browser-session variant
// (/ajax-api/...) returned in Knowledge Assistant citations and the REST one.
const FILES_API_PATH = /^\/(?:ajax-)?api\/2\.0\/fs\/files(\/Volumes\/.+)$/;

/**
 * Parses a Databricks Files API link to a PDF in a UC Volume.
 * Returns null for anything else, so callers can fall back to a normal link.
 */
export function parseDatabricksFileLink(
  href: string | undefined,
): PreviewDocument | null {
  if (!href) return null;

  let url: URL;
  try {
    const base =
      typeof window !== 'undefined'
        ? window.location.origin
        : 'http://localhost';
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const match = FILES_API_PATH.exec(url.pathname);
  if (!match) return null;

  let volumePath: string;
  try {
    volumePath = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!volumePath.toLowerCase().endsWith('.pdf')) return null;

  // Fragment looks like `#page=3:~:text=...`; only the page is usable, since
  // browser PDF viewers don't support text fragments.
  const pageMatch = /(?:^#|&)page=(\d+)/.exec(url.hash);
  const page = pageMatch ? Number.parseInt(pageMatch[1], 10) : undefined;

  return {
    volumePath,
    fileName: volumePath.split('/').pop() ?? volumePath,
    page: page && page > 0 ? page : undefined,
    originalHref: href,
  };
}

/** Same-origin URL that serves the PDF inline via the server proxy. */
export function buildPreviewUrl(doc: PreviewDocument): string {
  const base = `/api/files/preview?path=${encodeURIComponent(doc.volumePath)}`;
  return doc.page ? `${base}#page=${doc.page}` : base;
}

/**
 * Same as buildPreviewUrl, plus PDF open parameters for the embedded viewer:
 * - navpanes=0 hides the left thumbnail/outline sidebar
 * - view=FitH fits the page width to the panel (scroll vertically)
 */
export function buildEmbedPreviewUrl(doc: PreviewDocument): string {
  const base = `/api/files/preview?path=${encodeURIComponent(doc.volumePath)}`;
  const params = [
    ...(doc.page ? [`page=${doc.page}`] : []),
    'navpanes=0',
    'view=FitH',
  ];
  return `${base}#${params.join('&')}`;
}
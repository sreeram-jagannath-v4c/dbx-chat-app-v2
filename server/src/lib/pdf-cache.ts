import { getDatabricksToken } from '@chat-template/auth';
import { getWorkspaceHostname } from '@chat-template/ai-sdk-providers';

/**
 * In-memory cache of PDF bytes from UC Volumes.
 *
 * Each Files API request costs ~1s before the first byte, and pdf.js needs
 * ~10 sequential range requests to render one page of a large PDF. Fetching
 * the whole file once and serving ranges from memory turns that into a single
 * upstream request per file.
 *
 * The cache is shared across users. That is safe only because every read uses
 * the app's own credentials (getDatabricksToken), never a per-user token. If
 * per-user (OBO) file access is added, key entries by user as well.
 */

export interface CachedPdf {
  data: Buffer;
  lastModified?: string;
  etag?: string;
}

/** Upstream Files API failure, carrying its HTTP status. */
export class PdfFetchError extends Error {
  constructor(readonly status: number) {
    super(`Upstream error ${status}`);
  }
}

/** Raised when a file is too large to cache; callers stream it instead. */
export class PdfTooLargeError extends Error {}

const MAX_CACHE_BYTES =
  (Number(process.env.PDF_CACHE_MAX_MB) || 256) * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const TTL_MS = 10 * 60 * 1000;

interface Entry extends CachedPdf {
  expiresAt: number;
}

// Map iteration order is insertion order, so re-inserting on access makes
// the first key the least recently used.
const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<CachedPdf>>();
let totalBytes = 0;

function remove(volumePath: string) {
  const entry = entries.get(volumePath);
  if (!entry) return;
  entries.delete(volumePath);
  totalBytes -= entry.data.length;
}

function store(volumePath: string, pdf: CachedPdf) {
  remove(volumePath);
  if (pdf.data.length > MAX_CACHE_BYTES) return;
  while (totalBytes + pdf.data.length > MAX_CACHE_BYTES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    remove(oldest);
  }
  entries.set(volumePath, { ...pdf, expiresAt: Date.now() + TTL_MS });
  totalBytes += pdf.data.length;
}

function encodeVolumePath(volumePath: string): string {
  return volumePath.split('/').map(encodeURIComponent).join('/');
}

/** Files API URL and auth headers for a UC Volume path. */
export async function filesApiRequest(volumePath: string) {
  const [token, hostUrl] = await Promise.all([
    getDatabricksToken(),
    getWorkspaceHostname(),
  ]);
  return {
    url: `${hostUrl}/api/2.0/fs/files${encodeVolumePath(volumePath)}`,
    headers: { Authorization: `Bearer ${token}` } as Record<string, string>,
  };
}

async function download(volumePath: string): Promise<CachedPdf> {
  const { url, headers } = await filesApiRequest(volumePath);
  const upstream = await fetch(url, { headers });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw new PdfFetchError(upstream.status);
  }

  const length = Number(upstream.headers.get('content-length'));
  if (length > MAX_FILE_BYTES) {
    await upstream.body?.cancel();
    throw new PdfTooLargeError(`${volumePath} is ${length} bytes`);
  }

  const data = Buffer.from(await upstream.arrayBuffer());
  return {
    data,
    lastModified: upstream.headers.get('last-modified') ?? undefined,
    etag: upstream.headers.get('etag') ?? undefined,
  };
}

/**
 * Returns the PDF's bytes, downloading it once and sharing the download
 * between concurrent callers.
 */
export function getPdf(volumePath: string): Promise<CachedPdf> {
  const entry = entries.get(volumePath);
  if (entry && entry.expiresAt > Date.now()) {
    // Mark as most recently used
    entries.delete(volumePath);
    entries.set(volumePath, entry);
    return Promise.resolve(entry);
  }
  remove(volumePath);

  let promise = inFlight.get(volumePath);
  if (!promise) {
    promise = download(volumePath)
      .then((pdf) => {
        store(volumePath, pdf);
        return pdf;
      })
      .finally(() => inFlight.delete(volumePath));
    inFlight.set(volumePath, promise);
  }
  return promise;
}

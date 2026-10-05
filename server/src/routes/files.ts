import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  Router,
  type Request,
  type Response,
  type Router as RouterType,
} from 'express';
import { z } from 'zod';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { ChatSDKError, type ErrorCode } from '@chat-template/core/errors';
import { parseRange } from '../lib/byte-range';
import {
  filesApiRequest,
  getPdf,
  PdfFetchError,
  PdfTooLargeError,
} from '../lib/pdf-cache';

export const filesRouter: RouterType = Router();

filesRouter.use(authMiddleware);

// Upstream headers that are safe and useful to pass through to the browser.
// Range support lets the browser's PDF viewer load large files incrementally.
const PASSTHROUGH_HEADERS = [
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
];

function getAllowedPrefixes(): string[] {
  const raw = process.env.FILE_PREVIEW_ALLOWED_PREFIXES;
  const prefixes = raw
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return prefixes?.length ? prefixes : ['/Volumes/'];
}

const previewQuerySchema = z.object({
  path: z
    .string()
    .min(1)
    .refine((p) => p.startsWith('/Volumes/'), 'Path must be a UC Volume path')
    .refine(
      (p) =>
        !p.split('/').some((segment) => segment === '..' || segment === '.'),
      'Path must not contain relative segments',
    )
    .refine(
      (p) => p.toLowerCase().endsWith('.pdf'),
      'Only PDF files can be previewed',
    )
    .refine(
      (p) => getAllowedPrefixes().some((prefix) => p.startsWith(prefix)),
      'Path is not in an allowed location',
    ),
});

function sendError(res: Response, code: ErrorCode, cause?: string) {
  const response = new ChatSDKError(code, cause).toResponse();
  return res.status(response.status).json(response.json);
}

// RFC 6266: ASCII fallback plus UTF-8 encoded filename.
function inlineContentDisposition(fileName: string): string {
  const asciiName = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function setPdfHeaders(res: Response, fileName: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', inlineContentDisposition(fileName));
  res.setHeader('Cache-Control', 'private, max-age=300');
}

function sendUpstreamError(res: Response, status: number, volumePath: string) {
  console.error(`[files/preview] Upstream ${status} for ${volumePath}`);
  if (status === 401 || status === 403) {
    return sendError(res, 'forbidden:api', 'No access to this file');
  }
  // The Files API returns 400 when the path doesn't resolve to a volume.
  if (status === 400 || status === 404) {
    return sendError(res, 'not_found:api', 'File not found');
  }
  if (status === 416) {
    return res.status(416).end();
  }
  return sendError(res, 'offline:api', `Upstream error ${status}`);
}

/** Serves a cached PDF, honouring a single byte range. */
function sendCachedPdf(
  req: Request,
  res: Response,
  fileName: string,
  pdf: Awaited<ReturnType<typeof getPdf>>,
) {
  const size = pdf.data.length;
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }

  setPdfHeaders(res, fileName);
  res.setHeader('Accept-Ranges', 'bytes');
  if (pdf.lastModified) res.setHeader('Last-Modified', pdf.lastModified);
  if (pdf.etag) res.setHeader('ETag', pdf.etag);

  const { start, end } = range ?? { start: 0, end: size - 1 };
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  } else {
    res.status(200);
  }
  res.setHeader('Content-Length', end - start + 1);

  if (req.method === 'HEAD') return res.end();
  return res.end(pdf.data.subarray(start, end + 1));
}

/** Streams a PDF straight from the Files API (files too large to cache). */
async function proxyPdf(
  req: Request,
  res: Response,
  volumePath: string,
  fileName: string,
) {
  const { url, headers } = await filesApiRequest(volumePath);
  if (typeof req.headers.range === 'string') {
    headers.Range = req.headers.range;
  }

  const upstream = await fetch(url, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers,
  });

  if (!upstream.ok) {
    return sendUpstreamError(res, upstream.status, volumePath);
  }

  res.status(upstream.status);
  for (const header of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  setPdfHeaders(res, fileName);

  if (req.method === 'HEAD' || !upstream.body) {
    return res.end();
  }

  const body = Readable.fromWeb(upstream.body as NodeReadableStream);
  req.on('close', () => body.destroy());
  body.on('error', (error) => {
    console.error('[files/preview] Stream error:', error);
    res.destroy(error);
  });
  body.pipe(res);
}

/**
 * GET /api/files/preview?path=/Volumes/<catalog>/<schema>/<volume>/<file>.pdf
 *
 * Serves a PDF from the Databricks Files API so it can be rendered inline
 * (the Files API itself responds with `Content-Disposition: attachment`).
 * Files are cached in memory (see lib/pdf-cache) and byte ranges are served
 * from the cache; files too large to cache are streamed through. Uses the
 * app's credentials.
 */
filesRouter.get(
  '/preview',
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = previewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(
        res,
        'bad_request:api',
        parsed.error.issues.map((issue) => issue.message).join('; '),
      );
    }

    const volumePath = parsed.data.path;
    const fileName = volumePath.split('/').pop() ?? 'document.pdf';

    try {
      const pdf = await getPdf(volumePath);
      return sendCachedPdf(req, res, fileName, pdf);
    } catch (error) {
      if (error instanceof PdfFetchError) {
        return sendUpstreamError(res, error.status, volumePath);
      }
      if (!(error instanceof PdfTooLargeError)) {
        console.error('[files/preview] Error:', error);
        return sendError(res, 'offline:api', 'Failed to fetch file');
      }
    }

    try {
      await proxyPdf(req, res, volumePath, fileName);
    } catch (error) {
      console.error('[files/preview] Error:', error);
      return sendError(res, 'offline:api', 'Failed to fetch file');
    }
  },
);

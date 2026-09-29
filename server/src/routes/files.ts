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
import { getDatabricksToken } from '@chat-template/auth';
import { getWorkspaceHostname } from '@chat-template/ai-sdk-providers';

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

function encodeVolumePath(volumePath: string): string {
  return volumePath.split('/').map(encodeURIComponent).join('/');
}

// RFC 6266: ASCII fallback plus UTF-8 encoded filename.
function inlineContentDisposition(fileName: string): string {
  const asciiName = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * GET /api/files/preview?path=/Volumes/<catalog>/<schema>/<volume>/<file>.pdf
 *
 * Proxies a PDF from the Databricks Files API so it can be rendered inline
 * (the Files API itself responds with `Content-Disposition: attachment`).
 * Uses the user's OBO token when present, otherwise the app's credentials.
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
      const token = await getDatabricksToken();
      const hostUrl = await getWorkspaceHostname();

      const upstreamHeaders: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      };
      if (typeof req.headers.range === 'string') {
        upstreamHeaders.Range = req.headers.range;
      }

      const upstream = await fetch(
        `${hostUrl}/api/2.0/fs/files${encodeVolumePath(volumePath)}`,
        {
          method: req.method === 'HEAD' ? 'HEAD' : 'GET',
          headers: upstreamHeaders,
        },
      );

      if (!upstream.ok) {
        console.error(
          `[files/preview] Upstream ${upstream.status} for ${volumePath}`,
        );
        if (upstream.status === 401 || upstream.status === 403) {
          return sendError(res, 'forbidden:api', 'No access to this file');
        }
        // The Files API returns 400 when the path doesn't resolve to a volume.
        if (upstream.status === 400 || upstream.status === 404) {
          return sendError(res, 'not_found:api', 'File not found');
        }
        if (upstream.status === 416) {
          return res.status(416).end();
        }
        return sendError(
          res,
          'offline:api',
          `Upstream error ${upstream.status}`,
        );
      }

      res.status(upstream.status);
      for (const header of PASSTHROUGH_HEADERS) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', inlineContentDisposition(fileName));
      res.setHeader('Cache-Control', 'private, max-age=300');

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
    } catch (error) {
      console.error('[files/preview] Error:', error);
      return sendError(res, 'offline:api', 'Failed to fetch file');
    }
  },
);

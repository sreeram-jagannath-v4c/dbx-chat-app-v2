import { useEffect, useState } from 'react';
import { ExternalLink, FileText, X } from 'lucide-react';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import {
  useDocumentPreviewActions,
  usePreviewDocument,
} from '@/contexts/DocumentPreviewContext';
import {
  buildEmbedPreviewUrl,
  buildPreviewUrl,
  type PreviewDocument,
} from '@/lib/document-preview';
import { cn } from '@/lib/utils';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

function errorMessageForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "You don't have access to this file.";
  }
  if (status === 404) return 'This file could not be found.';
  return 'The file could not be loaded.';
}

/**
 * Docked panel that renders the currently previewed PDF with the browser's
 * built-in viewer. Full-screen overlay on small screens.
 */
export function DocumentPreviewPanel() {
  const doc = usePreviewDocument();
  if (!doc) return null;
  // Re-mount per document/page so load state and the iframe reset.
  return (
    <PreviewPanelContent key={`${doc.volumePath}#${doc.page}`} doc={doc} />
  );
}

function PreviewPanelContent({ doc }: { doc: PreviewDocument }) {
  const actions = useDocumentPreviewActions();
  const previewUrl = buildPreviewUrl(doc);
  const embedUrl = buildEmbedPreviewUrl(doc);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [iframeLoaded, setIframeLoaded] = useState(false);

  // The iframe can't report HTTP errors, so check the file first.
  useEffect(() => {
    const controller = new AbortController();
    fetch(previewUrl.split('#')[0], {
      method: 'HEAD',
      credentials: 'include',
      signal: controller.signal,
    })
      .then((response) => {
        setState(
          response.ok
            ? { status: 'ready' }
            : {
                status: 'error',
                message: errorMessageForStatus(response.status),
              },
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.error('Failed to load document preview:', error);
        setState({ status: 'error', message: 'The file could not be loaded.' });
      });
    return () => controller.abort();
  }, [previewUrl]);

  return (
    <aside
      aria-label={`Preview of ${doc.fileName}`}
      className={cn(
        'flex flex-col bg-background',
        // Mobile: full-screen overlay. Desktop: docked to the right of the chat.
        'fixed inset-0 z-50',
        'md:static md:z-auto md:h-dvh md:w-[45%] md:min-w-[360px] md:max-w-[900px] md:shrink-0 md:border-l',
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm" title={doc.fileName}>
            {doc.fileName}
          </p>
          {doc.page && (
            <p className="text-muted-foreground text-xs">Page {doc.page}</p>
          )}
        </div>
        <Button
          asChild
          variant="tertiary"
          className="h-8 w-8 p-0"
          title="Open in new tab"
        >
          <a href={previewUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink />
            <span className="sr-only">Open in new tab</span>
          </a>
        </Button>
        <Button
          variant="tertiary"
          className="h-8 w-8 p-0"
          title="Close preview"
          onClick={() => actions?.closePreview()}
        >
          <X />
          <span className="sr-only">Close preview</span>
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {state.status === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-muted-foreground text-sm">{state.message}</p>
            <Button asChild variant="default">
              <a
                href={doc.originalHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open original link
              </a>
            </Button>
          </div>
        ) : (
          <>
            {!iframeLoaded && (
              <div className="absolute inset-0 flex flex-col gap-3 p-4">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="w-full flex-1" />
              </div>
            )}
            {state.status === 'ready' && (
              <iframe
                src={embedUrl}
                title={doc.fileName}
                className="h-full w-full border-0"
                onLoad={() => setIframeLoaded(true)}
              />
            )}
          </>
        )}
      </div>
    </aside>
  );
}

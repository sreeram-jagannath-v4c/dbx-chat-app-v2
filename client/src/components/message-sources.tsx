import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { PdfPageThumbnail } from './pdf-page-thumbnail';
import { Skeleton } from './ui/skeleton';
import { useDocumentPreviewActions } from '@/contexts/DocumentPreviewContext';
import type { CitationEntry } from '@/lib/message-citations';
import { cn } from '@/lib/utils';

const cardClassName =
  'group flex shrink-0 flex-col overflow-hidden rounded-lg border bg-background text-left transition-[border-color,width] hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Cards for the sources cited in an assistant message, numbered to match the
 * inline citation markers. PDF sources show the cited page and open the
 * preview panel; other sources open in a new tab.
 */
export function MessageSources({
  entries,
  isLoading,
}: {
  entries: CitationEntry[];
  /** While streaming, thumbnails are deferred until sources settle. */
  isLoading: boolean;
}) {
  if (entries.length === 0) return null;

  return (
    <section aria-label="Sources" className="flex flex-col gap-2">
      <p className="font-medium text-muted-foreground text-xs">Sources</p>
      <div className="-mx-1 flex items-start gap-2 overflow-x-auto px-1 pb-1">
        {entries.map((entry) => (
          <SourceCard key={entry.key} entry={entry} isLoading={isLoading} />
        ))}
      </div>
    </section>
  );
}

function SourceCard({
  entry,
  isLoading,
}: {
  entry: CitationEntry;
  isLoading: boolean;
}) {
  const actions = useDocumentPreviewActions();
  // Width / height of the rendered page. Landscape pages (e.g. PDFs exported
  // from slide decks) get a wider card showing the whole page uncropped.
  const [pageAspectRatio, setPageAspectRatio] = useState<number>();
  const isLandscape = pageAspectRatio !== undefined && pageAspectRatio > 1;

  const thumbnail = (
    <div
      className={cn(
        'relative w-full overflow-hidden border-b bg-muted',
        !isLandscape && 'aspect-[3/4]',
      )}
      style={isLandscape ? { aspectRatio: pageAspectRatio } : undefined}
    >
      {entry.doc ? (
        isLoading ? (
          <Skeleton className="h-full w-full rounded-none" />
        ) : (
          <PdfPageThumbnail
            doc={entry.doc}
            onAspectRatio={setPageAspectRatio}
          />
        )
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ExternalLink className="size-6" />
        </div>
      )}
      <span className="absolute top-1.5 left-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded bg-background/90 px-1 font-medium text-[11px] shadow-sm">
        {entry.number}
      </span>
    </div>
  );
  const caption = (
    <div className="flex flex-col gap-0.5 p-2">
      <span className="truncate font-medium text-xs" title={entry.title}>
        {entry.title}
      </span>
      {entry.doc?.page && (
        <span className="text-[11px] text-muted-foreground">
          Page {entry.doc.page}
        </span>
      )}
      {entry.snippet && (
        <span
          className="line-clamp-2 text-[11px] text-muted-foreground italic"
          title={entry.snippet}
        >
          “{entry.snippet}”
        </span>
      )}
    </div>
  );
  const className = cn(cardClassName, isLandscape ? 'w-64' : 'w-36');

  if (entry.doc && actions) {
    const doc = entry.doc;
    return (
      <button
        type="button"
        className={cn(className, 'cursor-pointer')}
        onClick={() => actions.openPreview(doc)}
        aria-label={`Open source ${entry.number}: ${entry.title}`}
      >
        {thumbnail}
        {caption}
      </button>
    );
  }

  return (
    <a
      href={entry.url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      aria-label={`Open source ${entry.number}: ${entry.title}`}
    >
      {thumbnail}
      {caption}
    </a>
  );
}

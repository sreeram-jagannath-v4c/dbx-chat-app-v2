import { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { Skeleton } from './ui/skeleton';
import type { PreviewDocument } from '@/lib/document-preview';
import { getPdfThumbnail } from '@/lib/pdf-thumbnails';

type ThumbnailState =
  | { status: 'idle' | 'loading' | 'error' }
  | { status: 'ready'; src: string };

/**
 * Image of a PDF page, rendered in the browser once the element scrolls
 * into view. Falls back to a file icon if the page can't be rendered.
 */
export function PdfPageThumbnail({
  doc,
  // UPDATED: Increased the default width from 160 to 320 to fix blurriness on the cards
  width = 320,
}: {
  doc: PreviewDocument;
  width?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<ThumbnailState>({ status: 'idle' });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    setState({ status: 'loading' });

    getPdfThumbnail(doc, width)
      .then((src) => {
        if (!cancelled) setState({ status: 'ready', src });
      })
      .catch((error) => {
        console.error('Failed to render PDF thumbnail:', error);
        if (!cancelled) setState({ status: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [visible, doc, width]);

  return (
    <div ref={containerRef} className="h-full w-full">
      {state.status === 'ready' ? (
        <img
          src={state.src}
          alt={`Page ${doc.page ?? 1} of ${doc.fileName}`}
          // UPDATED: Changed `object-cover` to `object-contain` to stop the card image from zooming in and cropping
          className="h-full w-full object-contain object-top"
          draggable={false}
        />
      ) : state.status === 'error' ? (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <FileText className="size-8" />
        </div>
      ) : (
        <Skeleton className="h-full w-full rounded-none" />
      )}
    </div>
  );
}
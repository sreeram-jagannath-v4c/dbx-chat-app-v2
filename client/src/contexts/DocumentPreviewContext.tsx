import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  parseDatabricksFileLink,
  type PreviewDocument,
} from '@/lib/document-preview';

interface DocumentPreviewActions {
  openPreview: (doc: PreviewDocument) => void;
  closePreview: () => void;
}

// Actions and state live in separate contexts so that links inside memoized
// messages don't re-render every time the previewed document changes.
const DocumentPreviewActionsContext = createContext<
  DocumentPreviewActions | undefined
>(undefined);
const DocumentPreviewStateContext = createContext<PreviewDocument | null>(null);

export function DocumentPreviewProvider({
  resetKey,
  children,
}: {
  /** Clears the preview when this changes (e.g. the chat id). */
  resetKey?: string;
  children: React.ReactNode;
}) {
  const [doc, setDoc] = useState<PreviewDocument | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on key change
  useEffect(() => {
    setDoc(null);
  }, [resetKey]);

  useEffect(() => {
    if (!doc) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDoc(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [doc]);

  const openPreview = useCallback((next: PreviewDocument) => setDoc(next), []);
  const closePreview = useCallback(() => setDoc(null), []);
  const actions = useMemo(
    () => ({ openPreview, closePreview }),
    [openPreview, closePreview],
  );

  return (
    <DocumentPreviewActionsContext.Provider value={actions}>
      <DocumentPreviewStateContext.Provider value={doc}>
        {children}
      </DocumentPreviewStateContext.Provider>
    </DocumentPreviewActionsContext.Provider>
  );
}

export function usePreviewDocument() {
  return useContext(DocumentPreviewStateContext);
}

export function useDocumentPreviewActions() {
  return useContext(DocumentPreviewActionsContext);
}

/**
 * Returns an onClick handler that opens previewable file links (PDFs in UC
 * Volumes) in the preview panel. Modified clicks (ctrl/cmd/shift/middle) keep
 * the default new-tab behavior. Returns undefined outside a provider or for
 * links that can't be previewed.
 */
export function useFileLinkClickHandler(
  href: string | undefined,
): React.MouseEventHandler<HTMLAnchorElement> | undefined {
  const actions = useDocumentPreviewActions();
  const doc = useMemo(() => parseDatabricksFileLink(href), [href]);

  return useMemo(() => {
    if (!actions || !doc) return undefined;
    return (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      actions.openPreview(doc);
    };
  }, [actions, doc]);
}

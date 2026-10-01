import type { ChatMessage } from '@chat-template/core';
import {
  parseDatabricksFileLink,
  type PreviewDocument,
} from './document-preview';

type SourcePart = Extract<ChatMessage['parts'][number], { type: 'source-url' }>;

const CITATION_SUFFIX = '::databricks_citation';

// Adds a unique suffix to the link to indicate that it is a Databricks message citation.
const encodeDatabricksMessageCitationLink = (part: SourcePart) =>
  `${part.url}${CITATION_SUFFIX}`;

// Removes the unique suffix from the link to get the original link.
export const decodeDatabricksMessageCitationLink = (link: string) =>
  link.replace(CITATION_SUFFIX, '');

// Checks if the link is a Databricks message citation.
export const isDatabricksMessageCitationLink = (
  link?: string,
): link is `${string}::databricks_citation` =>
  link?.endsWith(CITATION_SUFFIX) ?? false;

// Creates a markdown link to the Databricks message citation.
// `label` (e.g. the citation number) defaults to the source title.
export const createDatabricksMessageCitationMarkdown = (
  part: SourcePart,
  label?: string,
) =>
  `[${label ?? (part.title || part.url)}](${encodeDatabricksMessageCitationLink(part)})`;

export interface CitationEntry {
  /** 1-based citation number shown inline and on the source card. */
  number: number;
  key: string;
  title: string;
  /** URL of the first citation of this source. */
  url: string;
  /** Previewable PDF at the cited page, or null for other links. */
  doc: PreviewDocument | null;
  /**
   * Start of the quoted chunk, from the link's `:~:text=` fragment. Only set
   * when every citation of this page quotes the same text; cleared otherwise.
   */
  snippet?: string;
}

export interface CitationIndex {
  entries: CitationEntry[];
  numberFor: (url: string) => number | undefined;
}

// One number (and card) per cited page: PDF links are keyed by file and page,
// so several chunks cited from the same page share a number and a single
// thumbnail. Non-PDF links are keyed by URL without the fragment.
function citationKey(url: string, doc: PreviewDocument | null): string {
  if (doc) {
    return `${doc.volumePath}#page=${doc.page ?? 1}`;
  }
  const hashIndex = url.indexOf('#');
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

// Raw value of a `:~:text=` directive (text fragment), if present.
function textFragment(hash: string): string | undefined {
  const match = /:~:(?:.*&)?text=([^&]*)/.exec(hash);
  return match?.[1] || undefined;
}

const MAX_SNIPPET_LENGTH = 160;

// Readable start of the quoted text. Text fragments look like
// `[prefix-,]textStart[,textEnd][,-suffix]` with each part URL-encoded.
function snippetFromUrl(url: string): string | undefined {
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return undefined;
  const fragment = textFragment(url.slice(hashIndex));
  if (!fragment) return undefined;

  const start = fragment.split(',').find((segment) => !segment.endsWith('-'));
  if (!start) return undefined;
  let text: string;
  try {
    text = decodeURIComponent(start);
  } catch {
    return undefined;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > MAX_SNIPPET_LENGTH
    ? `${text.slice(0, MAX_SNIPPET_LENGTH).trimEnd()}…`
    : text;
}

/**
 * Numbers the message's cited sources (one per PDF page) in order of first
 * appearance.
 */
export function buildCitationIndex(parts: ChatMessage['parts']): CitationIndex {
  const entries: CitationEntry[] = [];
  const byKey = new Map<string, CitationEntry>();
  const keyByUrl = new Map<string, string>();

  for (const part of parts) {
    if (part.type !== 'source-url') continue;
    const doc = parseDatabricksFileLink(part.url);
    const key = citationKey(part.url, doc);
    keyByUrl.set(part.url, key);

    const existing = byKey.get(key);
    if (existing) {
      // Another chunk from the same page: reuse the number and card. A single
      // snippet would misrepresent the page, so drop it if the quotes differ.
      if (existing.doc && existing.snippet !== snippetFromUrl(part.url)) {
        existing.snippet = undefined;
      }
      continue;
    }

    const entry: CitationEntry = {
      number: entries.length + 1,
      key,
      title: doc?.fileName ?? part.title ?? part.url,
      url: part.url,
      doc,
      snippet: doc ? snippetFromUrl(part.url) : undefined,
    };
    entries.push(entry);
    byKey.set(key, entry);
  }

  return {
    entries,
    numberFor: (url) => {
      const key =
        keyByUrl.get(url) ?? citationKey(url, parseDatabricksFileLink(url));
      return byKey.get(key)?.number;
    },
  };
}
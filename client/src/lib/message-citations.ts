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
}

export interface CitationIndex {
  entries: CitationEntry[];
  numberFor: (url: string) => number | undefined;
}

// One number (and card) per cited page: PDF links are keyed by file and page,
// so different chunks of the same page share a number. Non-PDF links are keyed
// by URL without the fragment.
function citationKey(url: string, doc: PreviewDocument | null): string {
  if (doc) return `${doc.volumePath}#page=${doc.page ?? 1}`;
  const hashIndex = url.indexOf('#');
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

/**
 * Numbers the message's cited sources in order of first appearance.
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
    if (byKey.has(key)) continue;

    const entry: CitationEntry = {
      number: entries.length + 1,
      key,
      title: doc?.fileName ?? part.title ?? part.url,
      url: part.url,
      doc,
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

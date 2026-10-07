import { randomUUID } from 'node:crypto';
import type { UIMessageChunk, UIMessageStreamWriter } from 'ai';
import type { KnowledgeScope } from './knowledge-access';

/**
 * Enforcement layer for a single knowledge agent that indexes many volumes.
 *
 * The agent's retrieval is not filtered per user, so the app:
 *  1. tells the agent which locations the user may use (soft control),
 *  2. buffers the response and refuses to release it if the answer text or
 *     its citations point into a volume the user cannot read (hard control),
 *     retrying once with a stricter instruction before giving up, and
 *  3. withholds reasoning / tool traces from restricted users, because those
 *     can contain passages retrieved from any volume.
 *
 * When the answer mixes documents the user can and cannot read, partial
 * answers are enabled by default: the paragraphs whose citations point into a
 * denied volume are removed and the rest is shown. Set
 * KNOWLEDGE_PARTIAL_ANSWERS=false to refuse such answers instead.
 */

const PARTIAL_ANSWERS = process.env.KNOWLEDGE_PARTIAL_ANSWERS !== 'false';

export const PARTIAL_NOTE =
  'Some details were left out because they come from documents you do not have access to.';

export const REFUSAL_MESSAGE =
  "I couldn't find an answer in the documents you have access to.";

export function buildScopeInstruction(scope: KnowledgeScope): string {
  return [
    'ACCESS POLICY for this conversation:',
    `Use ONLY documents stored under these locations: ${scope.allowedVolumes.join(', ')}.`,
    'Do not use, quote, cite or mention any document from any other location.',
    'Support every statement with a citation to a document in an allowed location.',
    'If the allowed documents do not contain the answer, say you could not find it in the documents available to the user. Do not answer from general knowledge.',
  ].join('\n');
}

export function buildStrictInstruction(scope: KnowledgeScope): string {
  return `${buildScopeInstruction(scope)}\nYour previous attempt referred to documents outside the allowed locations. Answer again, using strictly and only the allowed locations.`;
}

/** True when `text` contains a path inside `volume` (not a lookalike name). */
function mentionsVolume(text: string, volume: string): boolean {
  const haystack = text.toLowerCase();
  const needle = volume.toLowerCase();
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const next = haystack[index + needle.length];
    if (next === undefined || next === '/') return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

/** The parts of a response that reach the user: answer text and citations. */
function answerSurface(chunks: UIMessageChunk[]): string {
  let text = '';
  const extras: string[] = [];
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.delta;
        break;
      case 'source-url':
        extras.push(chunk.url, chunk.title ?? '');
        break;
      case 'source-document':
        extras.push(chunk.title ?? '', chunk.filename ?? '');
        break;
      default:
        break;
    }
  }
  return [text, ...extras].join('\n');
}

/** Denied volumes that the answer text or citations point into. */
export function findViolations(
  chunks: UIMessageChunk[],
  scope: KnowledgeScope,
): string[] {
  if (scope.deniedVolumes.length === 0) return [];
  const surface = answerSurface(chunks);
  const variants = [surface];
  try {
    variants.push(decodeURIComponent(surface));
  } catch {
    // Malformed escape sequences: the raw text is still checked.
  }
  return scope.deniedVolumes.filter((volume) =>
    variants.some((variant) => mentionsVolume(variant, volume)),
  );
}

function hasAnswerText(chunks: UIMessageChunk[]): boolean {
  return chunks.some(
    (chunk) => chunk.type === 'text-delta' && chunk.delta.trim().length > 0,
  );
}

const isTrace = (type: string) =>
  type.startsWith('reasoning') || type.startsWith('tool-');

/** Collects chunks instead of sending them, so they can be reviewed first. */
export class BufferedWriter {
  readonly chunks: UIMessageChunk[] = [];
  onError: undefined = undefined;
  write(chunk: UIMessageChunk) {
    this.chunks.push(chunk);
  }
  merge() {
    throw new Error('BufferedWriter does not support merge()');
  }
  asWriter(): UIMessageStreamWriter {
    return this as unknown as UIMessageStreamWriter;
  }
}

function refusalChunks(): UIMessageChunk[] {
  const id = randomUUID();
  return [
    { type: 'start-step' },
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: REFUSAL_MESSAGE },
    { type: 'text-end', id },
    { type: 'finish-step' },
  ];
}

export type ReleaseOutcome = 'ok' | 'filtered' | 'retried' | 'blocked';

const isSourceChunk = (chunk: UIMessageChunk) =>
  chunk.type === 'source-url' || chunk.type === 'source-document';

const isStepChunk = (chunk: UIMessageChunk) =>
  chunk.type === 'start-step' || chunk.type === 'finish-step';

type Item =
  | { kind: 'text'; chunks: UIMessageChunk[]; sources: UIMessageChunk[] }
  | { kind: 'source'; chunk: UIMessageChunk }
  | { kind: 'other'; chunk: UIMessageChunk };

/**
 * Removes the paragraphs that cite a volume the user cannot read.
 *
 * A text part and the sources that follow it are treated as one unit. If any
 * of the unit's text or citations points into a denied volume, the whole unit
 * is dropped (the text may be derived from that document). A denied source
 * that follows no text is dropped and counted as an orphan: we cannot tell
 * which text it belongs to, so callers should not keep a partial answer.
 */
export function filterToAllowed(
  chunks: UIMessageChunk[],
  scope: KnowledgeScope,
  options: { dropUncited?: boolean } = {},
): { chunks: UIMessageChunk[]; removed: number; orphans: number } {
  const items: Item[] = [];
  let openText: Extract<Item, { kind: 'text' }> | null = null;
  let lastText: Extract<Item, { kind: 'text' }> | null = null;

  for (const chunk of chunks) {
    if (chunk.type === 'text-start') {
      openText = { kind: 'text', chunks: [chunk], sources: [] };
      lastText = openText;
      items.push(openText);
    } else if (openText && (chunk.type === 'text-delta' || chunk.type === 'text-end')) {
      openText.chunks.push(chunk);
      if (chunk.type === 'text-end') openText = null;
    } else if (isSourceChunk(chunk)) {
      const target = openText ?? lastText;
      if (target) target.sources.push(chunk);
      else items.push({ kind: 'source', chunk });
    } else {
      if (!isStepChunk(chunk)) lastText = null;
      items.push({ kind: 'other', chunk });
    }
  }

  const out: UIMessageChunk[] = [];
  let removed = 0;
  let orphans = 0;
  for (const item of items) {
    if (item.kind === 'other') {
      out.push(item.chunk);
    } else if (item.kind === 'source') {
      if (findViolations([item.chunk], scope).length > 0) {
        removed++;
        orphans++;
      } else {
        out.push(item.chunk);
      }
    } else if (findViolations([...item.chunks, ...item.sources], scope).length > 0) {
      removed++;
    } else if (options.dropUncited && item.sources.length === 0) {
      // Text with no citation cannot be traced to an allowed document. When the
      // answer also drew on a denied volume, it may come from that volume.
      removed++;
    } else {
      out.push(...item.chunks, ...item.sources);
    }
  }
  return { chunks: out, removed, orphans };
}

/** The note that tells the user part of the answer was left out. */
function withNote(chunks: UIMessageChunk[]): UIMessageChunk[] {
  const id = randomUUID();
  const note: UIMessageChunk[] = [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: `\n\n${PARTIAL_NOTE}` },
    { type: 'text-end', id },
  ];
  // Keep the note inside the last step when there is one.
  let at = chunks.length;
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].type === 'finish-step') {
      at = i;
      break;
    }
  }
  return [...chunks.slice(0, at), ...note, ...chunks.slice(at)];
}


/** Compact view of a response (no content): e.g. "text(120)>src[all_files]>text(40)>src[all_files2]". */
function describeShape(chunks: UIMessageChunk[]): string {
  const parts: string[] = [];
  let len = 0;
  const flush = () => {
    if (len > 0) parts.push(`text(${len})`);
    len = 0;
  };
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') {
      len += chunk.delta.length;
    } else if (chunk.type === 'text-end') {
      flush();
    } else if (chunk.type === 'source-url') {
      flush();
      const match = /\/Volumes\/[^/]+\/[^/]+\/[^/#?]+/i.exec(chunk.url);
      parts.push(`src[${match ? match[0] : 'other'}]`);
    }
  }
  flush();
  return parts.join('>') || '(empty)';
}

/**
 * Removes the app's own refusal / partial-answer notices from earlier turns
 * before the history is sent back to the agent. Otherwise the agent sees
 * "I couldn't find an answer..." in its own past replies and tends to repeat
 * it, which makes later questions fail even when the documents are readable.
 */
export function stripGuardNotices<
  T extends { role: string; parts: Array<{ type: string; text?: string }> },
>(messages: T[]): T[] {
  return messages
    .map((message) => {
      if (message.role !== 'assistant') return message;
      const parts = message.parts
        .map((part) =>
          part.type === 'text' && typeof part.text === 'string'
            ? { ...part, text: part.text.split(PARTIAL_NOTE).join('').trim() }
            : part,
        )
        .filter(
          (part) =>
            !(
              part.type === 'text' &&
              (part.text === '' || part.text === REFUSAL_MESSAGE)
            ),
        );
      return { ...message, parts } as T;
    })
    .filter(
      (message) =>
        message.role !== 'assistant' ||
        message.parts.some((part) => part.type === 'text' || part.type.startsWith('tool-')),
    );
}

/** A filtered answer is usable when it still has text and no violations. */
function tryFilter(
  chunks: UIMessageChunk[],
  scope: KnowledgeScope,
): UIMessageChunk[] | null {
  if (!PARTIAL_ANSWERS) return null;
  const filtered = filterToAllowed(chunks, scope, { dropUncited: true });
  const leftover = findViolations(filtered.chunks, scope).length;
  const hasText = hasAnswerText(filtered.chunks);
  // An answer with no citation left is only commentary ("I could not find the
  // other document..."), not content from a document the user can read.
  const hasCitation = filtered.chunks.some(isSourceChunk);
  if (
    filtered.removed === 0 ||
    filtered.orphans > 0 ||
    !hasText ||
    !hasCitation ||
    leftover > 0
  ) {
    console.warn(
      `[knowledge-guard] Partial answer not possible: removed=${filtered.removed} orphanDeniedSources=${filtered.orphans} textLeft=${hasText} citationLeft=${hasCitation} violationsLeft=${leftover}. Stream shape: ${describeShape(chunks)}`,
    );
    return null;
  }
  return withNote(filtered.chunks);
}

/**
 * Reviews the buffered response and forwards it to `writer`.
 * On a violation it calls `regenerate` once (with a stricter instruction),
 * and falls back to a refusal if that also fails the review.
 */
export async function releaseGuarded(params: {
  buffered: BufferedWriter;
  writer: UIMessageStreamWriter;
  scope: KnowledgeScope;
  regenerate: (
    writer: UIMessageStreamWriter,
  ) => Promise<{ traceId?: string } | undefined>;
}): Promise<{ outcome: ReleaseOutcome; traceId?: string }> {
  const { buffered, writer, scope, regenerate } = params;
  const showTraces = scope.deniedVolumes.length === 0;
  const startChunks = buffered.chunks.filter((c) => c.type === 'start');

  let chunks = buffered.chunks;
  let outcome: ReleaseOutcome = 'ok';
  let traceId: string | undefined;

  const violations = findViolations(chunks, scope);
  if (violations.length > 0) {
    const partial = tryFilter(chunks, scope);
    if (partial) {
      console.warn(
        `[knowledge-guard] Response referenced inaccessible volume(s): ${violations.join(', ')}. Removed those parts and kept the rest.`,
      );
      chunks = partial;
      outcome = 'filtered';
    } else {
      console.warn(
        `[knowledge-guard] Response referenced inaccessible volume(s): ${violations.join(', ')}. Retrying once.`,
      );
      const retry = new BufferedWriter();
      const result = await regenerate(retry.asWriter());
      traceId = result?.traceId;

      const retryContent = retry.chunks.filter((c) => c.type !== 'start');
      const retryFailed = retryContent.some((c) => c.type === 'data-error');
      const retryPartial = retryFailed ? null : tryFilter(retryContent, scope);
      if (
        !retryFailed &&
        hasAnswerText(retryContent) &&
        findViolations(retryContent, scope).length === 0
      ) {
        chunks = [...startChunks, ...retryContent];
        outcome = 'retried';
      } else if (retryPartial) {
        chunks = [...startChunks, ...retryPartial];
        outcome = 'filtered';
      } else {
        console.warn('[knowledge-guard] Retry not usable; blocking the answer.');
        chunks = [...startChunks, ...refusalChunks()];
        outcome = 'blocked';
      }
    }
  }

  for (const chunk of chunks) {
    if (!showTraces && isTrace(chunk.type)) continue;
    writer.write(chunk);
  }
  return { outcome, traceId };
}
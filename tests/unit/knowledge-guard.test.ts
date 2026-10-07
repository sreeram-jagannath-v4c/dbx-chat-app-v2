import { expect, test } from '@playwright/test';
import type { UIMessageChunk } from 'ai';
import {
  BufferedWriter,
  PARTIAL_NOTE,
  REFUSAL_MESSAGE,
  filterToAllowed,
  findViolations,
  releaseGuarded,
} from '../../server/src/lib/knowledge-guard';

const HR = '/Volumes/poc/docs/hr';
const FINANCE = '/Volumes/poc/docs/finance';
const scope = { allowedVolumes: [HR], deniedVolumes: [FINANCE] };

const text = (...deltas: string[]): UIMessageChunk[] => [
  { type: 'text-start', id: 't' },
  ...deltas.map((delta) => ({ type: 'text-delta', id: 't', delta }) as UIMessageChunk),
  { type: 'text-end', id: 't' },
];
const source = (path: string): UIMessageChunk => ({
  type: 'source-url',
  sourceId: 's',
  url: `https://dbc.example.com/ajax-api/2.0/fs/files${path}#page=1`,
});

const collect = () => {
  const out = new BufferedWriter();
  return { out, writer: out.asWriter() };
};

test.describe('knowledge guard', () => {
  test('flags citations into volumes the user cannot read', () => {
    expect(findViolations([source(`${FINANCE}/a.pdf`)], scope)).toEqual([FINANCE]);
    expect(findViolations([source(`${HR}/a.pdf`)], scope)).toEqual([]);
  });

  test('detects a path split across text deltas and encoded paths', () => {
    expect(findViolations(text('see /Volumes/poc/do', 'cs/finance/x.pdf'), scope)).toEqual([FINANCE]);
    expect(findViolations([source('/Volumes/poc/docs/finance/My%20File.pdf')], scope)).toEqual([FINANCE]);
  });

  test('does not flag lookalike volume names', () => {
    expect(findViolations([source('/Volumes/poc/docs/finance_public/a.pdf')], scope)).toEqual([]);
  });

  test('releases a clean answer and withholds reasoning', async () => {
    const buffered = new BufferedWriter();
    buffered.write({ type: 'reasoning-start', id: 'r' });
    buffered.write({ type: 'reasoning-delta', id: 'r', delta: `looked in ${FINANCE}/x.pdf` });
    buffered.write({ type: 'reasoning-end', id: 'r' });
    text('Leave is 20 days.').forEach((c) => buffered.write(c));
    buffered.write(source(`${HR}/leave.pdf`));

    const { out, writer } = collect();
    const result = await releaseGuarded({
      buffered, writer, scope,
      regenerate: async () => { throw new Error('should not retry'); },
    });
    expect(result.outcome).toBe('ok');
    expect(out.chunks.some((c) => c.type.startsWith('reasoning'))).toBe(false);
    expect(JSON.stringify(out.chunks)).toContain('Leave is 20 days.');
  });

  test('retries once, then falls back to a refusal', async () => {
    const leaky = new BufferedWriter();
    text('Budget is 5M.').forEach((c) => leaky.write(c));
    leaky.write(source(`${FINANCE}/b.pdf`));

    const retried = collect();
    const r1 = await releaseGuarded({
      buffered: leaky, writer: retried.writer, scope,
      regenerate: async (w) => { text('Leave is 20 days.').forEach((c) => w.write(c)); return undefined; },
    });
    expect(r1.outcome).toBe('retried');
    expect(JSON.stringify(retried.out.chunks)).not.toContain('5M');

    const blocked = collect();
    const r2 = await releaseGuarded({
      buffered: leaky, writer: blocked.writer, scope,
      regenerate: async (w) => { w.write(source(`${FINANCE}/b.pdf`)); text('Still 5M.').forEach((c) => w.write(c)); return undefined; },
    });
    expect(r2.outcome).toBe('blocked');
    const sent = JSON.stringify(blocked.out.chunks);
    expect(sent).toContain(REFUSAL_MESSAGE.slice(0, 20));
    expect(sent).not.toContain('5M');
  });

  test('users with access to every volume are not restricted', () => {
    expect(findViolations([source(`${FINANCE}/a.pdf`)], { allowedVolumes: [HR, FINANCE], deniedVolumes: [] })).toEqual([]);
  });

  test('keeps allowed paragraphs and drops the ones citing a denied volume', async () => {
    const mixed = new BufferedWriter();
    text('Leave is 20 days.').forEach((c) => mixed.write(c));
    mixed.write(source(`${HR}/leave.pdf`));
    mixed.write({ type: 'text-start', id: 'b' });
    mixed.write({ type: 'text-delta', id: 'b', delta: 'Budget is 5M.' });
    mixed.write({ type: 'text-end', id: 'b' });
    mixed.write(source(`${FINANCE}/b.pdf`));

    const { out, writer } = collect();
    const result = await releaseGuarded({
      buffered: mixed, writer, scope,
      regenerate: async () => { throw new Error('should not retry'); },
    });
    const sent = JSON.stringify(out.chunks);
    expect(result.outcome).toBe('filtered');
    expect(sent).toContain('Leave is 20 days.');
    expect(sent).toContain(PARTIAL_NOTE);
    expect(sent).not.toContain('5M');
    expect(sent).not.toContain(FINANCE);
  });

  test('a paragraph citing both allowed and denied volumes is removed whole', () => {
    const chunks: UIMessageChunk[] = [
      ...text('Blend of both.'),
      source(`${HR}/a.pdf`),
      source(`${FINANCE}/b.pdf`),
    ];
    const { chunks: kept, removed } = filterToAllowed(chunks, scope);
    expect(removed).toBe(1);
    expect(kept).toEqual([]);
  });
});
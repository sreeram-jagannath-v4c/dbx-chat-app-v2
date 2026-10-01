import { expect, test } from '@playwright/test';
import type { ChatMessage } from '@chat-template/core';
import { buildCitationIndex } from '../../client/src/lib/message-citations';
import { joinMessagePartSegments } from '../../client/src/components/databricks-message-part-transformers';

type Part = ChatMessage['parts'][number];

const HOST = 'https://dbc-example.cloud.databricks.com';
const fileUrl = (file: string, page: number, quote = 'quote') =>
  `${HOST}/ajax-api/2.0/fs/files/Volumes/poc/docs/all/${encodeURIComponent(file)}#page=${page}:~:text=${encodeURIComponent(quote)}`;

const text = (value: string) => ({ type: 'text', text: value }) as Part;
const source = (url: string, title?: string) =>
  ({ type: 'source-url', sourceId: url, url, title }) as Part;

test.describe('buildCitationIndex', () => {
  test('numbers each cited page in order of first appearance', () => {
    const parts = [
      text('A.'),
      source(fileUrl('b.pdf', 2, 'first chunk'), 'b.pdf'),
      text('B.'),
      source(fileUrl('a.pdf', 1), 'a.pdf'),
      text('C.'),
      source(fileUrl('b.pdf', 7), 'b.pdf'),
      text('D.'),
      source(fileUrl('b.pdf', 2, 'second chunk'), 'b.pdf'),
      text('E.'),
      source(fileUrl('b.pdf', 2, 'first chunk'), 'b.pdf'),
    ];
    const index = buildCitationIndex(parts);

    // Chunks from the same page share one number and one card.
    expect(
      index.entries.map((e) => [e.number, e.title, e.doc?.page, e.snippet]),
    ).toEqual([
      [1, 'b.pdf', 2, undefined], // two different quotes on this page
      [2, 'a.pdf', 1, 'quote'],
      [3, 'b.pdf', 7, 'quote'],
    ]);
    expect(index.numberFor(fileUrl('b.pdf', 2, 'first chunk'))).toBe(1);
    expect(index.numberFor(fileUrl('b.pdf', 2, 'second chunk'))).toBe(1);
  });

  test('keeps the snippet when a page is cited once or with the same quote', () => {
    const index = buildCitationIndex([
      source(fileUrl('a.pdf', 1, 'same'), 'a.pdf'),
      source(fileUrl('a.pdf', 1, 'same'), 'a.pdf'),
    ]);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].snippet).toBe('same');
  });

  test('extracts a readable snippet from the text fragment', () => {
    const url = `${fileUrl('a.pdf', 1)}`.replace(
      /text=.*$/,
      `text=${encodeURIComponent('Multi-Optimizer\nEnsemble')},${encodeURIComponent('end')}`,
    );
    const [entry] = buildCitationIndex([source(url, 'a.pdf')]).entries;
    expect(entry.snippet).toBe('Multi-Optimizer Ensemble');
  });

  test('keys non-PDF links by URL without fragment', () => {
    const index = buildCitationIndex([
      source('https://example.com/page#one', 'Example'),
      source('https://example.com/page#two', 'Example'),
      source('https://example.com/other', 'Other'),
    ]);
    expect(index.entries.map((e) => e.number)).toEqual([1, 2]);
    expect(index.entries[0].doc).toBeNull();
    expect(index.numberFor('https://example.com/page#two')).toBe(1);
  });

  test('returns no entries when there are no sources', () => {
    expect(buildCitationIndex([text('hello')]).entries).toEqual([]);
  });
});

test.describe('joinMessagePartSegments with numbering', () => {
  test('labels citations with their number and collapses repeats', () => {
    const parts = [
      text('First.'),
      source(fileUrl('a.pdf', 1), 'a.pdf'),
      source(fileUrl('a.pdf', 1), 'a.pdf'),
      source(fileUrl('a.pdf', 3), 'a.pdf'),
    ];
    const { numberFor } = buildCitationIndex(parts);
    const markdown = joinMessagePartSegments(parts, numberFor);

    expect(markdown).toBe(
      `First. [1](${fileUrl('a.pdf', 1)}::databricks_citation) [2](${fileUrl('a.pdf', 3)}::databricks_citation)`,
    );
  });

  test('collapses adjacent citations from different chunks of one page', () => {
    const parts = [
      text('Fact.'),
      source(fileUrl('a.pdf', 1, 'one'), 'a.pdf'),
      source(fileUrl('a.pdf', 1, 'two'), 'a.pdf'),
      source(fileUrl('a.pdf', 1, 'three'), 'a.pdf'),
    ];
    const { numberFor } = buildCitationIndex(parts);
    expect(joinMessagePartSegments(parts, numberFor)).toBe(
      `Fact. [1](${fileUrl('a.pdf', 1, 'one')}::databricks_citation)`,
    );
  });

  test('keeps the table pipe special case', () => {
    const parts = [text('| cell |'), source(fileUrl('a.pdf', 1), 'a.pdf')];
    const { numberFor } = buildCitationIndex(parts);
    expect(joinMessagePartSegments(parts, numberFor)).toBe(
      `| cell  [1](${fileUrl('a.pdf', 1)}::databricks_citation)|`,
    );
  });

  test('falls back to titles without an index', () => {
    const parts = [text('Hi.'), source('https://example.com/x', 'Example')];
    expect(joinMessagePartSegments(parts)).toBe(
      'Hi. [Example](https://example.com/x::databricks_citation)',
    );
  });
});
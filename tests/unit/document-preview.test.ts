import { expect, test } from '@playwright/test';
import {
  buildEmbedPreviewUrl,
  buildPreviewUrl,
  parseDatabricksFileLink,
} from '../../client/src/lib/document-preview';

const HOST = 'https://dbc-example.cloud.databricks.com';

test.describe('parseDatabricksFileLink', () => {
  test('parses a Knowledge Assistant citation URL with page and text fragment', () => {
    const href = `${HOST}/ajax-api/2.0/fs/files/Volumes/poc/agent_files/all_files/Meat_Quality_Grading%20%283%29.pdf#page=3:~:text=Multi-Optimizer%20Ensemble`;
    expect(parseDatabricksFileLink(href)).toEqual({
      volumePath:
        '/Volumes/poc/agent_files/all_files/Meat_Quality_Grading (3).pdf',
      fileName: 'Meat_Quality_Grading (3).pdf',
      page: 3,
      originalHref: href,
    });
  });

  test('parses the REST Files API variant without a page', () => {
    const doc = parseDatabricksFileLink(
      `${HOST}/api/2.0/fs/files/Volumes/cat/sch/vol/report.PDF`,
    );
    expect(doc?.volumePath).toBe('/Volumes/cat/sch/vol/report.PDF');
    expect(doc?.page).toBeUndefined();
  });

  test('ignores non-PDF files, non-Volume paths and other links', () => {
    expect(
      parseDatabricksFileLink(
        `${HOST}/ajax-api/2.0/fs/files/Volumes/c/s/v/a.txt`,
      ),
    ).toBeNull();
    expect(
      parseDatabricksFileLink(`${HOST}/ajax-api/2.0/fs/files/tmp/a.pdf`),
    ).toBeNull();
    expect(parseDatabricksFileLink('https://example.com/paper.pdf')).toBeNull();
    expect(parseDatabricksFileLink('#footnote-1')).toBeNull();
    expect(parseDatabricksFileLink('mailto:someone@example.com')).toBeNull();
    expect(parseDatabricksFileLink(undefined)).toBeNull();
  });

  test('ignores invalid page numbers', () => {
    const doc = parseDatabricksFileLink(
      `${HOST}/ajax-api/2.0/fs/files/Volumes/c/s/v/a.pdf#page=0`,
    );
    expect(doc?.page).toBeUndefined();
  });
});

test.describe('buildPreviewUrl', () => {
  test('builds a same-origin proxy URL with the page fragment', () => {
    expect(
      buildPreviewUrl({
        volumePath: '/Volumes/c/s/v/My File.pdf',
        fileName: 'My File.pdf',
        page: 2,
        originalHref: '',
      }),
    ).toBe(
      '/api/files/preview?path=%2FVolumes%2Fc%2Fs%2Fv%2FMy%20File.pdf#page=2',
    );
  });

  test('embed URL hides the nav pane and fits width, keeping the page', () => {
    expect(
      buildEmbedPreviewUrl({
        volumePath: '/Volumes/c/s/v/My File.pdf',
        fileName: 'My File.pdf',
        page: 2,
        originalHref: '',
      }),
    ).toBe(
      '/api/files/preview?path=%2FVolumes%2Fc%2Fs%2Fv%2FMy%20File.pdf#page=2&navpanes=0&view=FitH',
    );
  });
});

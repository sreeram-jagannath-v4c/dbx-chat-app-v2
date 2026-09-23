import { expect, test } from '../fixtures';

const previewUrl = (path: string) =>
  `/api/files/preview?path=${encodeURIComponent(path)}`;

test.describe('/api/files/preview', () => {
  test('serves a Volume PDF inline', async ({ adaContext }) => {
    const response = await adaContext.request.get(
      previewUrl('/Volumes/poc/agent_files/all_files/Report (1).pdf'),
    );

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('application/pdf');
    expect(response.headers()['content-disposition']).toMatch(/^inline;/);
    expect(response.headers()['content-disposition']).toContain(
      'filename="Report (1).pdf"',
    );
    expect((await response.body()).toString()).toContain('%PDF');
  });

  test('maps missing files to 404', async ({ adaContext }) => {
    const response = await adaContext.request.get(
      previewUrl('/Volumes/poc/agent_files/all_files/missing.pdf'),
    );
    expect(response.status()).toBe(404);
  });

  for (const path of [
    '/etc/passwd.pdf',
    '/Volumes/poc/../secrets.pdf',
    '/Volumes/poc/agent_files/all_files/notes.txt',
  ]) {
    test(`rejects invalid path ${path}`, async ({ adaContext }) => {
      const response = await adaContext.request.get(previewUrl(path));
      expect(response.status()).toBe(400);
    });
  }

  test('rejects requests without a path', async ({ adaContext }) => {
    const response = await adaContext.request.get('/api/files/preview');
    expect(response.status()).toBe(400);
  });
});

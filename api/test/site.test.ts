import { afterAll, beforeAll, expect, test } from 'vitest';
import worker from '../src/index';
import { startHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.dispose());

const get = async (path: string, verification?: string) => {
  const res = await worker.fetch(new Request(`https://api.test${path}`), { ...h.env, GOOGLE_SITE_VERIFICATION: verification }, {} as ExecutionContext);
  return { status: res.status, type: res.headers.get('Content-Type'), text: await res.text() };
};

test('serves only the Search Console file it was given', async () => {
  const ok = await get('/google1a2b3c4d.html', 'google1a2b3c4d.html');
  expect(ok.status).toBe(200);
  expect(ok.type).toContain('text/html');
  expect(ok.text).toBe('google-site-verification: google1a2b3c4d.html');

  expect((await get('/google0000.html', 'google1a2b3c4d.html')).status).toBe(404);
  expect((await get('/google1a2b3c4d.html')).status).toBe(404);
});

import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { b64url } from '../src/crypto';
import { DRIVE_SCOPE, decodeIdToken } from '../src/google';
import { ORIGIN, driveJson, fakeDrive, startHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => (h = await startHarness()));
afterAll(() => h.dispose());
beforeEach(() => h.reset());
afterEach(() => vi.unstubAllGlobals());

const idToken = (claims: Record<string, unknown>) =>
  ['e30', b64url(new TextEncoder().encode(JSON.stringify(claims))), 'sig'].join('.');

/** Google's token endpoint, answering with this profile and, unless told otherwise, a refresh token. */
function fakeGoogle(claims: Record<string, unknown>, refresh = true) {
  fakeDrive(() =>
    driveJson({
      access_token: 'access',
      expires_in: 3600,
      scope: `openid email ${DRIVE_SCOPE}`,
      id_token: idToken(claims),
      ...(refresh ? { refresh_token: 'refresh' } : {}),
    }),
  );
}

/** Starts signing in with this nonce, then comes back from Google. Returns where the callback sends the browser. */
async function signIn(nonce?: string) {
  const start = await h.call(`/auth/google/start${nonce !== undefined ? `?n=${nonce}` : ''}`);
  expect(start.status).toBe(302);
  const cookie = start.headers.get('Set-Cookie')!.split(';')[0];
  const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
  const back = await h.call(`/auth/google/callback?code=c&state=${state}`, { headers: { Cookie: cookie } });
  expect(back.status).toBe(302);
  return back.headers.get('Location')!;
}

const NONCE = 'AbCdEfGhIjKlMnOpQrStUvWx';

test('hands the sign-in nonce back with the session, so the web app can tell it started this sign-in', async () => {
  fakeGoogle({ sub: 's1', email: 'host@example.com', name: 'Host' });
  const to = await signIn(NONCE);
  expect(to).toMatch(new RegExp(`^${ORIGIN}/snapwall/#/auth/[\\w-]{40,}/${NONCE}$`));
});

test('leaves out a nonce that is missing or malformed', async () => {
  fakeGoogle({ sub: 's1', email: 'host@example.com', name: 'Host' });
  expect(await signIn()).toMatch(/#\/auth\/[\w-]+$/);
  expect(await signIn('short')).toMatch(/#\/auth\/[\w-]+$/);
  expect(await signIn('has.a.dot.in.it.and.is.long')).toMatch(/#\/auth\/[\w-]+$/);
});

test('keeps the nonce when Google is asked again for consent', async () => {
  fakeGoogle({ sub: 'new', email: 'host@example.com', name: 'Host' }, false);
  expect(await signIn(NONCE)).toBe(`/auth/google/start?consent=1&n=${NONCE}`);
});

test('keeps names written in any script', async () => {
  const name = 'José 李雷 Müller';
  expect(decodeIdToken(idToken({ sub: 's', email: 'e@example.com', name })).name).toBe(name);

  fakeGoogle({ sub: 's2', email: 'jose@example.com', name });
  await signIn(NONCE);
  const row = await h.env.DB.prepare('SELECT name FROM owners WHERE google_sub = ?').bind('s2').first<{ name: string }>();
  expect(row?.name).toBe(name);
});

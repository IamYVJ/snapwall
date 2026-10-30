import { expect, test } from 'vitest';
import { decodeHandoff, encodeHandoff, linkRoute, merge, upsert, type SavedEvent } from './saved';

const ev = (id: string, role: SavedEvent['role'], seen: number, path = role === 'admin' ? `a/${id}/tok` : `e/g${id}`): SavedEvent => ({
  id,
  name: `Event ${id}`,
  date: null,
  path,
  role,
  seen,
});

test('upsert keeps one entry per event, newest first', () => {
  const list = upsert(upsert([], ev('1', 'guest', 1)), ev('2', 'guest', 2));
  expect(list.map((e) => e.id)).toEqual(['2', '1']);
  const again = upsert(list, { ...ev('1', 'guest', 3), path: 'e/rotated' });
  expect(again.map((e) => e.id)).toEqual(['1', '2']);
  expect(again[0].path).toBe('e/rotated');
});

test("a guest visit doesn't replace a co-host link to the same event", () => {
  const list = upsert([ev('1', 'admin', 1)], { ...ev('1', 'guest', 2), name: 'Renamed' });
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ role: 'admin', path: 'a/1/tok', name: 'Renamed', seen: 2 });
  expect(upsert(list, ev('1', 'admin', 3, 'a/1/new'))[0].path).toBe('a/1/new');
});

test('merge keeps the newer entry and prefers admin links', () => {
  const mine = [ev('1', 'guest', 5), ev('2', 'guest', 1)];
  const merged = merge(mine, [ev('1', 'guest', 2, 'e/old'), ev('2', 'admin', 0), ev('3', 'guest', 3)]);
  expect(merged.find((e) => e.id === '1')?.path).toBe('e/g1');
  expect(merged.find((e) => e.id === '2')?.role).toBe('admin');
  expect(merged.map((e) => e.id).sort()).toEqual(['1', '2', '3']);
});

test('handoff round-trips, names with any characters included', () => {
  const h = { events: [{ ...ev('1', 'admin', 7), name: 'Priya & Rohan’s शादी 🎉', date: '2026-11-02' }, ev('2', 'guest', 3)], session: 'sess_1', to: 'e/g2' };
  const code = encodeHandoff(h);
  expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeHandoff(code)).toEqual(h);
});

test('a mangled or hostile handoff is ignored', () => {
  expect(decodeHandoff('not-base64!')).toBeNull();
  expect(decodeHandoff(encodeHandoff({ events: [], session: null, to: '' }).slice(0, 5))).toBeNull();
  const code = encodeHandoff({ events: [{ ...ev('1', 'guest', 1), path: 'javascript:alert(1)' }], session: null, to: 'https://evil.test' });
  expect(decodeHandoff(code)).toEqual({ events: [], session: null, to: '' });
});

test('linkRoute finds the event in a pasted link', () => {
  expect(linkRoute('https://iamyvj.github.io/snapwall/#/e/AbC_12-x')).toBe('e/AbC_12-x');
  expect(linkRoute('Join us! https://iamyvj.github.io/snapwall/#/a/wedding00001/tok_9-Z see you')).toBe('a/wedding00001/tok_9-Z');
  expect(linkRoute('https://iamyvj.github.io/snapwall/#/e/AbC/show')).toBe('e/AbC');
  expect(linkRoute('https://iamyvj.github.io/snapwall/#/manage/wedding00001')).toBeNull();
  expect(linkRoute('hello')).toBeNull();
});

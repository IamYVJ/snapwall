import { expect, test } from 'vitest';
import { autoCloseAt, bytesLabel, driveSpace, plural, sizeLabel } from './format';

test('autoCloseAt', () => {
  const now = new Date(2026, 9, 30, 15, 0).getTime();
  const sec = (d: Date) => d.getTime() / 1000;
  // The last minute of the 7th day after the event.
  expect(autoCloseAt('2026-10-28', now)).toBe(sec(new Date(2026, 10, 4, 23, 59)));
  expect(autoCloseAt('2026-12-31', now)).toBe(sec(new Date(2027, 0, 7, 23, 59)));
  // No date, or an event long past: a week from now.
  expect(autoCloseAt(null, now)).toBe(now / 1000 + 7 * 86400);
  expect(autoCloseAt('2026-01-01', now)).toBe(now / 1000 + 7 * 86400);
});

test('plural', () => {
  expect(plural(1, 'file')).toBe('1 file');
  expect(plural(0, 'file')).toBe('0 files');
  expect(plural(2, 'person', 'people')).toBe('2 people');
});

test('sizeLabel', () => {
  expect(sizeLabel(250)).toBe('250 MB');
  expect(sizeLabel(2.7)).toBe('2 MB');
  expect(sizeLabel(-3)).toBe('0 MB');
  expect(sizeLabel(1000)).toBe('1 GB');
  expect(sizeLabel(1500)).toBe('1.5 GB');
});

const GB = 2 ** 30;

test('bytesLabel matches the units Google shows', () => {
  expect(bytesLabel(15 * GB)).toBe('15 GB');
  expect(bytesLabel(1.25 * GB)).toBe('1.3 GB');
  expect(bytesLabel(300 * 2 ** 20)).toBe('300 MB');
  expect(bytesLabel(-5)).toBe('0 MB');
});

test('driveSpace warns when the Drive is low or full', () => {
  expect(driveSpace({ limit: 15 * GB, usage: 5 * GB })).toBeNull();
  expect(driveSpace({ limit: null, usage: 500 * GB })).toBeNull();
  expect(driveSpace({ limit: 15 * GB, usage: 13.5 * GB })).toEqual({ level: 'low', free: '1.5 GB', total: '15 GB' });
  // Over 90% used warns even with more than 2 GB left.
  expect(driveSpace({ limit: 2048 * GB, usage: 1900 * GB })?.level).toBe('low');
  expect(driveSpace({ limit: 15 * GB, usage: 15 * GB - 50 * 2 ** 20 })).toEqual({ level: 'full', free: '50 MB', total: '15 GB' });
  expect(driveSpace({ limit: 15 * GB, usage: 16 * GB })?.level).toBe('full');
});

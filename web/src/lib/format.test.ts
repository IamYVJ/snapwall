import { expect, test } from 'vitest';
import { plural, sizeLabel } from './format';

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

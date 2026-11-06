import assert from 'node:assert/strict';
import test from 'node:test';
import { artistOf, timeOf, titleOf, type MediaItem } from '../src/library';

const item: MediaItem = {
  id: 'd2e83f31-d764-480f-9bf9-aa21519125a6',
  name: 'A night at sea.mp4',
  category: 'video',
  mimeType: 'video/mp4',
  size: 100,
  duration: 3605,
  hasThumbnail: false,
  updatedAt: 0,
  artist: '',
  album: '',
  description: '',
};

test('human-friendly labels retain the real filename as a fallback', () => {
  assert.equal(titleOf(item), 'A night at sea');
  assert.equal(titleOf({ ...item, name: 'Untitled' }), 'Untitled');
  assert.equal(titleOf({ ...item, name: 'The Quiet Signal.2024.1080p.mp4' }), 'The Quiet Signal');
  assert.equal(titleOf({ ...item, name: 'Blade Runner 2049.2017.2160p.mkv' }), 'Blade Runner 2049');
  assert.equal(artistOf(item), 'Your music library');
  assert.equal(artistOf({ ...item, artist: 'The Composers' }), 'The Composers');
});

test('player and film durations never display NaN or a missing zero position', () => {
  assert.equal(timeOf(0), '0:00');
  assert.equal(timeOf(65), '1:05');
  assert.equal(timeOf(3605), '1:00:05');
  assert.equal(timeOf(undefined), '—');
  assert.equal(timeOf(Number.NaN), '—');
});

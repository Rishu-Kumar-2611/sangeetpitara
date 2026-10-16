import test from 'node:test';
import assert from 'node:assert/strict';
import { liveAudioTracks, prepareDisplayAudioStream } from './capture-tracks.js';

function track(kind, readyState = 'live') {
  return { kind, readyState, enabled: true };
}

test('keeps the display track live but returns only audio tracks', () => {
  const video = track('video');
  const audio = track('audio');
  const stream = {
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
  };

  assert.deepEqual(prepareDisplayAudioStream(stream), [audio]);
  assert.equal(video.enabled, false);
  assert.equal(video.readyState, 'live');
  assert.deepEqual(liveAudioTracks(stream), [audio]);
});

test('rejects a display stream whose audio track has already ended', () => {
  const stream = {
    getVideoTracks: () => [track('video')],
    getAudioTracks: () => [track('audio', 'ended')],
  };

  assert.throws(() => prepareDisplayAudioStream(stream), /live audio track/);
  assert.deepEqual(liveAudioTracks(stream), []);
});

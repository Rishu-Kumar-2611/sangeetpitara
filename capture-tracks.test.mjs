import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayAudioCaptureConstraints,
  displayAudioCaptureGuidance,
  liveAudioTracks,
  mobileAudioCaptureGuidance,
  prepareDisplayAudioStream,
} from './capture-tracks.js';

function track(kind, readyState = 'live') {
  return { kind, readyState, enabled: true };
}

test('requests system and tab audio without microphone-style processing', () => {
  assert.deepEqual(displayAudioCaptureConstraints(), {
    video: true,
    audio: {
      suppressLocalAudioPlayback: false,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    systemAudio: 'include',
    windowAudio: 'system',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  });
});

test('explains that Firefox screen sharing does not provide room audio', () => {
  assert.match(displayAudioCaptureGuidance('Mozilla/5.0 Firefox/146.0'), /Firefox.*does not provide a live system-audio track/i);
  assert.match(displayAudioCaptureGuidance('Mozilla/5.0 Chrome/146.0'), /Chrome or Edge.*audio control/i);
});

test('directs mobile browsers to the native app for phone playback audio', () => {
  const android = mobileAudioCaptureGuidance('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/146.0 Mobile');
  assert.equal(android.downloadHref, '/downloads/SangeetPitara-debug.apk');
  assert.match(android.title, /Android app/);
  assert.match(android.message, /cannot capture playback/i);
  assert.equal(mobileAudioCaptureGuidance('Mozilla/5.0 (X11; Linux x86_64) Chrome/146.0'), null);
});

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

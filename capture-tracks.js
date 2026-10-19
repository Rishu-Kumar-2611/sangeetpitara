/**
 * Keep a display-capture session alive while publishing only its audio.
 * Chrome requires the display video track to remain live for the lifetime of
 * a display-audio capture session, but SangeetPitara must not negotiate video to
 * an audio-only Android listener.
 */
export function displayAudioCaptureConstraints() {
  return {
    video: true,
    audio: {
      // Do not ask the browser to mute the local source while it is captured.
      suppressLocalAudioPlayback: false,
    },
    // These are browser hints, not guarantees. Chromium uses them to expose
    // the system/tab-audio choices when the selected surface supports them.
    systemAudio: 'include',
    windowAudio: 'system',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  };
}

export function displayAudioCaptureGuidance(userAgent = '') {
  if (/Firefox\/|FxiOS\//i.test(String(userAgent))) {
    return 'Firefox can share the screen here, but this browser does not provide a live system-audio track for SangeetPitara. Open SangeetPitara in Google Chrome or Microsoft Edge on the laptop, then choose a Chrome tab with Share tab audio or a screen with Share system audio.';
  }
  return 'The browser returned the screen without a live audio track. In Chrome or Edge, choose a tab or screen that is actively playing sound and enable Share tab audio or Share system audio. If the picker has no audio control, switch to Chrome or Edge or choose Test audio.';
}

export function prepareDisplayAudioStream(stream) {
  const videoTracks = stream?.getVideoTracks?.() || [];
  videoTracks.forEach((track) => {
    // Disabling is safe; stopping the track can terminate the coupled audio
    // capture session in some Chrome versions.
    track.enabled = false;
  });

  const audioTracks = stream?.getAudioTracks?.() || [];
  if (!audioTracks.some((track) => track.readyState !== 'ended')) {
    throw new Error('The selected source did not provide a live audio track. The source app or browser may block capture.');
  }
  return audioTracks;
}

export function liveAudioTracks(stream) {
  return (stream?.getAudioTracks?.() || []).filter((track) => track.readyState !== 'ended');
}

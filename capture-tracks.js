/**
 * Keep a display-capture session alive while publishing only its audio.
 * Chrome requires the display video track to remain live for the lifetime of
 * a display-audio capture session, but RoomSound must not negotiate video to
 * an audio-only Android listener.
 */
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

# UI integration contract

The final visual refinement must preserve these behavior boundaries.

## Diagnostics

`audio-diagnostics.mjs` owns the versioned export schema, allowlists and bounded
history. `stream-health.mjs` owns numeric thresholds and recent counters. Neither
module requires DOM, colors or a theme. Web sampling runs independently of panel
visibility; rendering is a consumer. Native sampling belongs to the service-owned
`RoomSessionCoordinator`, not the Activity lifecycle. Offline rooms embed the same
JavaScript diagnostic model through `desktop/sync-nearby-theme.mjs`.

Keep `schemaVersion: 1` backwards-compatible. Additive measurements are optional;
absence means unmeasured, never a fabricated zero. A future schema change requires
export/parser tests and versioning. No audio, identity, invite, IP, endpoint,
free-form exception or message content may enter the exported records.

## Controls and lifecycle

Retain existing control IDs and accessibility labels unless tests are updated
alongside them. `export-audio-diagnostics` triggers a local file save. Native
`REQUEST_AUDIO_DIAGNOSTICS` must remain distinct from MediaProjection consent and
notification request codes. Do not restart capture/socket/player when switching
tabs, changing themes, opening diagnostics, exporting or resizing the page.

Display sender and playback health separately. Sender queues are not speaker
latency. Label measured values, ideal ranges and unknown values in words as well
as colors. Volume, RMS and epochs are not network-strength scores. Preserve actual
consent requirements and source-lease authorization for all sharing controls.

## Packaging and publication

For browser modules, update `server.mjs` public asset allowlist,
`Dockerfile.runtime`, syntax checks and consistent asset-version query strings.
Keep backend-only modules private. Resync the offline page after shared theme or
diagnostic model edits. Test desktop and phone layouts, native export/consent,
offline listening and signed-update compatibility before publishing.

The branch intentionally retains the current public version/cache identity while
the UI is unfinished. Increment versionName/versionCode/cache token together for
the final release, then verify signed artifacts before advancing public main.

# SangeetPitara 1.0.1

## Release identity

- Android package: `com.roomsound.android` (unchanged).
- Android version: `1.0.1`, version code `3`.
- Distribution: debug-signed sideload APK, not a Google Play release.
- Public server: `https://sangeet-pitaraa.onrender.com`.
- Browser asset version: `20261024-prod`.
- APK: `downloads/SangeetPitara-1.0.1-debug.apk`.
- Compatible stable alias: `downloads/SangeetPitara-debug.apk`.
- Both APK files: 28,974,182 bytes.
- APK SHA-256: `1f33b146ff2f95401b5d38ed114e0df6ef005633d1d25624b075c84129116c9b`.

The signing certificate matches the previous public APK. Install the update
over the existing application; no uninstall or application-data reset is needed.

## Included changes

- Browser-first entry, clearer room codes, and larger approval controls.
- Browser requests can be reviewed while another participant is sharing.
- AudioWorklet capture with continuous resampling and bounded message backlog;
  a compatibility capture fallback remains available.
- Android service-owned playback, foreground notification, audio-focus handling,
  and scoped CPU/Wi-Fi protection across background listening and recovery.
- Android hardware-buffer prefill followed by continuous PCM writes, with bounded
  queues, partial-write preservation, and stale source/sequence rejection.

## Verified before publishing

- `npm test`: 80 tests (including the build-context regressions), plus origin,
  payload, and RTC checks passed on Node 22.14.0 and Node 26.8.1.
- `npm run check` and `git diff --check`: passed.
- `node checks/release-local.mjs`: isolated HTTP asset/APK hash checks and the
  room-control smoke flow passed; the smoke room is explicitly ended afterward.
- Android `testDebugUnitTest`, `assembleDebug`, `lintDebug`, and
  `exportPublicDebugApk`: passed. 65 unit tests; lint had 0 errors and 38 warnings.
- APK signature verified, package/version inspected, both export hashes equal.
- The rollback APK is byte-identical to the previous Git-tracked public APK.

Local JavaScript and isolated release checks also passed on the production-pinned
Node 22.14.0 runtime. The local Docker engine was unavailable, so a local Linux
container build was not completed. Real browser capture and phone screen-off
listening remain manual acceptance checks; automated results do not prove audible
quality.

## Deployment build-context repair

The deployed service used the default `Dockerfile` and its
`RUN npm test && npm run check` step, rather than `Dockerfile.runtime` from the
blueprint. The release guard reads `.gitignore`, but `.dockerignore` excluded that
file from `COPY . .`, producing an `ENOENT` test failure in the build context.

The repair keeps this non-secret test input in the context. Git history, private
environment files, and local Android artifacts remain excluded. The new
`docker-context.test.mjs` reproduces the missing-file failure in an isolated fixture
and verifies that the actual release guard passes with the repaired inputs. No
tests were skipped or removed, and the Android 1.0.1 binaries were not rebuilt or
changed by this repair.

## Build and deployment verification

From `android/`, set `ROOMSOUND_BUILD_DIR` to an existing external build directory
when a sync tool locks generated outputs, then run:

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug :app:exportPublicDebugApk --offline --no-daemon --console=plain
```

On Windows use `gradlew.bat`. Export preserves the previous stable APK once and
then updates both public filenames. The existing Render blueprint deploys on
commits to the linked branch; a successful push alone is not deployment proof.
From the repository root, verify the public deployment:

```sh
node checks/release.mjs https://sangeet-pitaraa.onrender.com --wait
ROOMSOUND_SMOKE_WS_URL=wss://sangeet-pitaraa.onrender.com npm run smoke
```

The release check compares deployed browser assets and both full APK downloads
against the local release, verifies health/readiness, and confirms PCM relay is
enabled without logging the full configuration. It performs read-only requests.
The smoke check creates its own test room and ends it on success.

## Rollback reference

- Previous source revision: `306d4c81557094a87a27abc77ed79fa75d09023c`.
- Previous APK: version `1.0.0`, version code `2`.
- Local ignored backup: `android/artifacts/rollback/SangeetPitara-before-1.0.1-debug.apk`.
- Previous APK Git blob: `9c1b8416ce3a842ad59b7e464dbe5f36339fa862`.

If a rollback is requested, revert the release and its release-specific follow-up
commits together, run the old release's checks, and push a normal new commit; do
not reset shared history or force-push. Verify the previous website
and download are live again. This does not downgrade applications already
installed on phones: to restore the old behavior without requiring an uninstall,
build the previous Android source with a version code above the installed code,
using the same signing key, and publish it as a clearly identified rollback update.

Manual acceptance: update the APK, reload the laptop website, create/join a room,
share eligible playback, listen continuously, lock/unlock the phone, press Home,
switch apps, test source handoff/reconnect, and confirm Stop listening/Leave stops
the foreground session. Audio focus, source-app capture policy, Android force-stop,
and actual device shutdown are not equivalent to simply switching apps or sleeping
the screen.

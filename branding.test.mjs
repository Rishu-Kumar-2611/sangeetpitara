import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('.', import.meta.url);
const resource = (name) => readFile(new URL(`android/app/src/main/res/${name}`, root), 'utf8');

test('Android branding uses SangeetPitara without changing installed app identity', async () => {
  const [strings, manifest, build, activity] = await Promise.all([
    resource('values/strings.xml'),
    readFile(new URL('android/app/src/main/AndroidManifest.xml', root), 'utf8'),
    readFile(new URL('android/app/build.gradle.kts', root), 'utf8'),
    readFile(new URL('android/app/src/main/java/com/roomsound/android/MainActivity.kt', root), 'utf8'),
  ]);
  assert.match(strings, /<string name="app_name">SangeetPitara<\/string>/);
  assert.match(strings, /<string name="header_title">SangeetPitara<\/string>/);
  assert.doesNotMatch(strings, /RoomSound/);
  assert.match(manifest, /android:label="@string\/app_name"/);
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
  assert.match(build, /applicationId = "com\.roomsound\.android"/);
  assert.match(build, /ROOMSOUND_DEFAULT_ENDPOINT/);
  assert.match(build, /wss:\/\/sangeet-pitaraa\.onrender\.com/);
  assert.match(activity, /Enter your name before creating a room/);
  assert.match(activity, /Enter a room name before creating a room/);
  assert.match(activity, /setImageResource\(R\.mipmap\.ic_launcher\)/);
});

test('Android launcher and notification artwork stay vector-only and support themed masks', async () => {
  const [foreground, notification] = await Promise.all([
    resource('drawable/ic_launcher_foreground.xml'),
    resource('drawable/ic_stat_diya.xml'),
  ]);
  assert.match(foreground, /05-diya-eighth-note\.svg/);
  for (const artwork of [foreground, notification]) {
    assert.match(artwork, /<vector\b/);
    assert.match(artwork, /android:viewportWidth="512"/);
    assert.match(artwork, /<path\b/);
    assert.doesNotMatch(artwork, /<bitmap\b|<image\b/);
  }
  for (const folder of ['mipmap-anydpi', 'mipmap-anydpi-v33']) {
    for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
      const icon = await resource(`${folder}/${name}`);
      assert.match(icon, /<adaptive-icon\b/);
      assert.match(icon, /@color\/sangeetpitara_icon_background/);
      assert.match(icon, /<foreground android:drawable="@drawable\/ic_launcher_foreground"/);
      if (folder.endsWith('v33')) assert.match(icon, /<monochrome\b/);
    }
  }
});

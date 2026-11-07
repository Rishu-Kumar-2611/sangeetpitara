import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('release identity has one current version across Node and Android defaults', async () => {
  const [properties, packageJson, lockfile, gradle, web, offline] = await Promise.all([
    readFile(new URL('./release.properties', import.meta.url), 'utf8'),
    readFile(new URL('./package.json', import.meta.url), 'utf8'),
    readFile(new URL('./package-lock.json', import.meta.url), 'utf8'),
    readFile(new URL('./android/app/build.gradle.kts', import.meta.url), 'utf8'),
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./android/app/src/main/assets/nearby/index.html', import.meta.url), 'utf8'),
  ]);
  const name = properties.match(/^VERSION_NAME=(.+)$/m)?.[1]?.trim();
  const code = properties.match(/^VERSION_CODE=(\d+)$/m)?.[1]?.trim();
  assert.match(name || '', /^\d+\.\d+\.\d+$/);
  assert.match(code || '', /^\d+$/);
  assert.equal(web.match(/name="app-version" content="([^"]+)"/)?.[1],name);
  assert.equal(offline.match(/name="app-version" content="([^"]+)"/)?.[1],name);
  assert.equal(JSON.parse(packageJson).version, name);
  assert.equal(JSON.parse(lockfile).version, name);
  assert.match(gradle, new RegExp(`releaseProperties\\.getProperty\\("VERSION_NAME", "${name}"\\)`));
  assert.match(gradle, new RegExp(`releaseProperties\\.getProperty\\("VERSION_CODE", "${code}"\\)`));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('./', import.meta.url);
const fixtureFiles = [
  'browser-surface.test.mjs', 'index.html', 'Dockerfile.runtime', '.dockerignore',
  '.gitignore', 'checks/syntax.mjs', 'capture-tracks.js', 'media-relay.mjs',
  'relay-pcm.js', 'relay-capture-worklet.js', 'relay-playout-worklet.js', 'manifest.webmanifest',
];

async function runReleaseGuard(t, omitGitignore) {
  // Only known public test inputs are copied; never copy .env, .git or user data.
  const directory = await mkdtemp(join(process.env.ROOMSOUND_TEST_TMP || tmpdir(), 'roomsound-build-context-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of fixtureFiles) {
    if (file === '.gitignore' && omitGitignore) continue;
    const destination = join(directory, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(new URL(file, root), destination);
  }
  const env = { ...process.env };
  // This subprocess is an independent runner, not a child test worker.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap', '--test-name-pattern=release download',
    'browser-surface.test.mjs',
  ], { cwd: directory, env, encoding: 'utf8', timeout: 15_000 });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

test('release guard reproduces the Docker failure when Git ignore metadata is absent', async (t) => {
  const result = await runReleaseGuard(t, true);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /ENOENT/);
  assert.match(result.output, /\.gitignore/);
  assert.match(result.output, /not ok \d+ - release download/);
});

test('Docker context retains metadata and the actual release guard passes', async (t) => {
  const rules = (await readFile(new URL('.dockerignore', root), 'utf8'))
    .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  // Protect the exact exclusion that broke COPY . . in the default Dockerfile.
  // This is a focused regression, not a replacement Docker glob implementation.
  const excluded = rules.includes('.gitignore');
  const result = await runReleaseGuard(t, excluded);
  assert.equal(result.status, 0, result.output);
  assert.ok(rules.includes('.git/'), 'Git history must remain excluded.');
  assert.ok(rules.includes('.env'), 'Private environment files must remain excluded.');
  assert.ok(rules.includes('.env.*'), 'Private environment variants must remain excluded.');
});

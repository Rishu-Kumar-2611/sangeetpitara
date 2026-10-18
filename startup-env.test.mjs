import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const probe = 'process.stdout.write(JSON.stringify({ fromFile: process.env.FROM_FILE, preserved: process.env.PRESERVED }))';

function runEnvProbe(directory, processEnv = {}) {
  const env = { ...process.env };
  delete env.FROM_FILE;
  delete env.PRESERVED;
  Object.assign(env, processEnv);

  return spawnSync(process.execPath, [
    '--env-file-if-exists=.env',
    '--input-type=module',
    '--eval',
    probe,
  ], {
    cwd: directory,
    env,
    encoding: 'utf8',
  });
}

test('npm start loads optional .env values without replacing process environment', () => {
  assert.equal(packageJson.scripts.start, 'node --env-file-if-exists=.env server.mjs');

  const directory = mkdtempSync(join(tmpdir(), 'roomsound-env-'));
  try {
    writeFileSync(join(directory, '.env'), 'FROM_FILE=from-file\nPRESERVED=from-file\n');

    const loaded = runEnvProbe(directory);
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.deepEqual(JSON.parse(loaded.stdout), {
      fromFile: 'from-file',
      preserved: 'from-file',
    });

    const preserved = runEnvProbe(directory, { PRESERVED: 'from-process' });
    assert.equal(preserved.status, 0, preserved.stderr);
    assert.deepEqual(JSON.parse(preserved.stdout), {
      fromFile: 'from-file',
      preserved: 'from-process',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('npm start remains usable when .env is absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'roomsound-no-env-'));
  try {
    const result = runEnvProbe(directory, { PRESERVED: 'from-process' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      preserved: 'from-process',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

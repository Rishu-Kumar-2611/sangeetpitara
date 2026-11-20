// Full encrypted backup rehearsal against a fresh disposable PostgreSQL instance.
// Accepts no database URL and cannot restore over an existing database.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { encryptBackup, decryptBackup } from '../ops/backup-crypto.mjs';

const name = 'sangeetpitara-backup-restore-' + randomBytes(6).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'sangeetpitara-restore-check-'));
const file = join(directory, 'synthetic.sgb');
const key = randomBytes(32).toString('hex');
let started = false;
let plain;
const testEnv = { ...process.env, POSTGRES_PASSWORD: randomBytes(24).toString('hex') };
const run = args => execFileSync('docker', args, { env: testEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
function streamed(args) {
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const done = once(child, 'exit').then(([code]) => { if (code !== 0) throw new Error('Disposable PostgreSQL backup operation failed.'); });
  done.catch(() => {});
  return { child, done };
}
try {
  run(['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD', 'postgres:18-alpine']);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { run(['exec', name, 'pg_isready', '-U', 'postgres']); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  assert.ok(ready, 'Disposable restore database did not become ready.');
  run(['exec', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE source_check']);
  run(['exec', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE restore_check']);
  run(['exec', name, 'psql', '-U', 'postgres', '-d', 'source_check', '-v', 'ON_ERROR_STOP=1',
    '-c', "CREATE TABLE backup_probe (id integer PRIMARY KEY, marker text NOT NULL); INSERT INTO backup_probe VALUES (1,'verified');"]);
  const dump = streamed(['exec', name, 'pg_dump', '-U', 'postgres', '-d', 'source_check', '--format=custom', '--no-owner', '--no-acl']);
  dump.child.stdin.end();
  await encryptBackup(dump.child.stdout, file, key);
  await dump.done;
  plain = await decryptBackup(file, key);
  const restore = streamed(['exec', '-i', name, 'pg_restore', '-U', 'postgres', '-d', 'restore_check',
    '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl']);
  restore.child.stdout.resume();
  createReadStream(plain.file).pipe(restore.child.stdin);
  await restore.done;
  const result = run(['exec', name, 'psql', '-U', 'postgres', '-d', 'restore_check', '-tAc',
    "SELECT count(*) FROM backup_probe WHERE id=1 AND marker='verified'"]);
  assert.equal(result.trim(), '1');
  console.log('BACKUP RESTORE PASS: encrypted real PostgreSQL dump restored into a separate disposable database; synthetic row verified.');
} finally {
  await plain?.remove();
  if (started && /^sangeetpitara-backup-restore-[a-f0-9]{12}$/.test(name)) run(['rm', '-f', name]);
  if (resolve(dirname(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('sangeetpitara-restore-check-')) throw new Error('Unsafe cleanup path.');
  await rm(file, { force: true });
  await rmdir(directory);
}

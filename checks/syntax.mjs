import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'server.mjs',
  'auth.mjs',
  'persistence.mjs',
  'security.mjs',
  'migrate.mjs',
  'billing.mjs',
  'account-client.mjs',
  'ads.mjs',
  'media-relay.mjs',
  'app.js',
  'relay-pcm.js',
  'relay-capture-worklet.js',
  'notifications-sw.js',
  'checks/release.mjs',
  'checks/release-local.mjs',
  'smoke.mjs',
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, file)], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'server.mjs',
  'client-address.mjs',
  'auth.mjs',
  'persistence.mjs',
  'security.mjs',
  'migrate.mjs',
  'billing.mjs',
  'config.mjs',
  'account-client.mjs',
  'ads.mjs',
  'media-relay.mjs',
  'app.js',
  'chat-content.mjs',
  'chat-ui.mjs',
  'stream-health.mjs',
  'audio-diagnostics.mjs',
  'themes.js',
  'room-palette.js',
  'relay-pcm.js',
  'relay-opus.mjs',
  'relay-capture-worklet.js',
  'relay-playout-worklet.js',
  'notifications-sw.js',
  'checks/release.mjs',
  'checks/release-local.mjs',
  'smoke.mjs',
];

// The production-only image excludes desktop tools and Android assets.
const developmentFiles = ['desktop/nearby-desktop.mjs', 'desktop/package-desktop.mjs', 'desktop/sync-nearby-theme.mjs', 'ops/backup-crypto.mjs', 'ops/database-backup.mjs', 'checks/capacity.mjs', 'checks/recovery-drill.mjs', 'checks/repository-safety.mjs'];
for (const file of [...files, ...developmentFiles.filter(file => existsSync(resolve(root,file)))]) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, file)], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (existsSync(resolve(root,'desktop/sync-nearby-theme.mjs'))) {
  const sync = spawnSync(process.execPath, [resolve(root, 'desktop/sync-nearby-theme.mjs'), '--check'], { cwd: root, stdio: 'inherit' });
  if (sync.status !== 0) process.exit(sync.status ?? 1);
}

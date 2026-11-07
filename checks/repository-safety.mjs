import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function privateRepositoryPaths(paths) {
  return paths.filter(path => {
    if (['.env.example','ops/env.production.example'].includes(path)) return false;
    if (path === 'desktop/test-fixtures/test-only-key.pem') return false;
    return /(^|\/)(\.env(?:\..*)?|\.neon|\.private-migration|\.desktop-package)(\/|$)/.test(path)
      || /\.(jks|keystore|sgb|p12|pfx)$/i.test(path)
      || /SangeetPitara-audio-diagnostics\.json$/i.test(path);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  const unsafe=privateRepositoryPaths(paths);
  if(unsafe.length)throw new Error('Private runtime/export files must not be tracked: '+unsafe.join(', '));
  console.log('REPOSITORY SAFETY PASS: no private environment, signing, backup or diagnostic-export paths tracked.');
}

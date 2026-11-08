import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,mkdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { spawnSync } from 'node:child_process';
test('offline bundle checks accept CRLF checkouts but reject real source drift',async t=>{
 const root=await mkdtemp(join(tmpdir(),'sangeetpitara-bundle-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files=['desktop/sync-nearby-theme.mjs','themes.css','themes.js','chat.css','chat-ui.mjs','audio-diagnostics.mjs','android/app/src/main/assets/nearby/index.html'];
 for(const file of files){const path=join(root,file);await mkdir(dirname(path),{recursive:true});const source=await readFile(new URL(file,import.meta.url),'utf8');await writeFile(path,source.replaceAll('\r\n','\n').replaceAll('\n','\r\n'));}
 const check=()=>spawnSync(process.execPath,[join(root,'desktop/sync-nearby-theme.mjs'),'--check'],{encoding:'utf8'});
 let result=check();assert.equal(result.status,0,result.stderr);
 await writeFile(join(root,'audio-diagnostics.mjs'),'\nconst deliberatelyChanged=1;\n',{flag:'a'});
 result=check();assert.notEqual(result.status,0);assert.match(result.stderr,/update bundled/);
});

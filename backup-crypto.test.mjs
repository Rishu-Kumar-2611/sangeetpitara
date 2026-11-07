import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { encryptBackup,decryptBackup } from './ops/backup-crypto.mjs';
test('encrypted backups round trip, reject tampering/wrong keys, and never overwrite existing files',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'sangeetpitara-backup-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const file=join(directory,'sample.sgb'),key=randomBytes(32).toString('hex'),payload=randomBytes(131072);
 await encryptBackup(Readable.from([payload]),file,key);const encrypted=await readFile(file);assert.ok(!encrypted.includes(payload.subarray(0,64)));
 const plain=await decryptBackup(file,key);try{assert.deepEqual(await readFile(plain.file),payload);}finally{await plain.remove();}
 await assert.rejects(decryptBackup(file,randomBytes(32).toString('hex')));
 await assert.rejects(encryptBackup(Readable.from(['overwrite']),file,key));assert.deepEqual(await readFile(file),encrypted);
 encrypted[25]^=1;await writeFile(join(directory,'damaged.sgb'),encrypted);await assert.rejects(decryptBackup(join(directory,'damaged.sgb'),key));
});

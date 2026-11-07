import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, mkdtemp, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
const MAGIC=Buffer.from('SPBK0001');
function keyBytes(key){if(!/^[a-f\d]{64}$/i.test(key||''))throw new Error('BACKUP_ENCRYPTION_KEY must contain 64 hex characters.');return Buffer.from(key,'hex');}
export async function encryptBackup(source,file,key){
  const secret=keyBytes(key),header=Buffer.concat([MAGIC,randomBytes(12)]),cipher=createCipheriv('aes-256-gcm',secret,header.subarray(8));
  cipher.setAAD(header);let output,created=false;
  try {
    output=createWriteStream(file,{flags:'wx',mode:0o600});await once(output,'open');created=true;output.write(header);
    await pipeline(source,cipher,output,{end:false});const done=once(output,'finish');output.end(cipher.getAuthTag());await done;
  }catch(error){output?.destroy();if(created)await rm(file,{force:true});throw error;}
}
export async function decryptBackup(file,key){
  const secret=keyBytes(key),input=await open(file,'r');let directory;
  const remove=async()=>{if(directory){if(resolve(dirname(directory))!==resolve(tmpdir())||!basename(directory).startsWith('sangeetpitara-backup-'))throw new Error('Unsafe temporary directory.');await rm(directory,{recursive:true,force:true});directory=null;}};
  try {
    const {size}=await input.stat();if(size<37)throw new Error('Invalid backup.');
    const header=Buffer.alloc(20),tag=Buffer.alloc(16);await input.read(header,0,20,0);await input.read(tag,0,16,size-16);
    if(!header.subarray(0,8).equals(MAGIC))throw new Error('Unknown backup format.');
    directory=await mkdtemp(join(tmpdir(),'sangeetpitara-backup-'));const plain=join(directory,'database.dump');
    const decipher=createDecipheriv('aes-256-gcm',secret,header.subarray(8));decipher.setAAD(header);decipher.setAuthTag(tag);
    await pipeline(createReadStream(file,{start:20,end:size-17}),decipher,createWriteStream(plain,{flags:'wx',mode:0o600}));
    return {file:plain,remove};
  }catch(error){await remove();throw error;}finally{await input.close();}
}

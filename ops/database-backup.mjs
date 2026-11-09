// Explicit manual operation. No scheduler or production restore is installed.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { readFile,writeFile,stat,rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { encryptBackup,decryptBackup } from './backup-crypto.mjs';
const action=process.argv[2],arg=name=>process.argv[process.argv.indexOf(name)+1];
// Copying the key from a terminal often adds a trailing newline or spaces; ignore them.
const key=(process.env.BACKUP_ENCRYPTION_KEY||'').trim();
if(!/^[a-f\d]{64}$/i.test(key||''))throw new Error('BACKUP_ENCRYPTION_KEY must be exactly 64 hex characters (0-9, a-f), e.g. from crypto.randomBytes(32).toString("hex"). Never send it in chat or put it in command arguments.');
function tool(name,args=[],env={}){
 const child=spawn('docker',['run','--rm','-i',...Object.keys(env).flatMap(k=>['--env',k]),'postgres:18-alpine',name,...args],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
 child.stdin.on('error',()=>{});
 let category='tool_or_connection';child.stderr.on('data',chunk=>{const message=chunk.toString();for(const [pattern,label] of [[/version mismatch/i,'version_mismatch'],[/certificate|SSL|TLS/i,'tls_configuration'],[/password authentication|no password/i,'authentication'],[/permission denied/i,'permission'],[/does not exist/i,'database_missing'],[/could not translate|name.*resolve|Name or service/i,'dns'],[/refused|timed out/i,'connection']])if(pattern.test(message))category=label;});const done=once(child,'exit').then(([code])=>{if(code!==0)throw new Error('PostgreSQL tool failed: '+category+'. Credentials are not logged.');});
 done.catch(()=>{});return {child,done};
}
if(action==='create'){
 if(!process.argv.includes('--output'))throw new Error('Pass --output to a private backup folder.');
 const file=arg('--output'),connection=process.argv.includes('--connection-file')?(await readFile(arg('--connection-file'),'utf8')).trim():process.env.DATABASE_URL_UNPOOLED;
 if(!connection)throw new Error('Use DATABASE_URL_UNPOOLED or a private --connection-file.');
 const url=new URL(connection);if(url.hostname.includes('-pooler.'))throw new Error('Backups require a direct connection.');
 const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 const env={PGHOST:local?'host.docker.internal':url.hostname,PGPORT:url.port||'5432',PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGCONNECT_TIMEOUT:'15',PGSSLMODE:local?'disable':'verify-full',...(!local?{PGSSLROOTCERT:'system'}:{})};
 const {child,done}=tool('pg_dump',['--format=custom','--no-owner','--no-acl'],env);child.stdin.end();
 let created=false;
 try{await encryptBackup(child.stdout,file,key);created=true;await done;
   const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
   await writeFile(file+'.json',JSON.stringify({format:'SPBK0001/AES-256-GCM',createdAt:new Date().toISOString(),bytes:(await stat(file)).size,sha256:hash.digest('hex')},null,2),{flag:'wx',mode:0o600});
   console.log('BACKUP PASS: encrypted PostgreSQL archive and checksum manifest saved. Store the key separately.');
 }catch(error){child.kill();if(created)await rm(file,{force:true});throw error;}
}else if(action==='verify'){
 if(!process.argv.includes('--file'))throw new Error('Pass --file with the encrypted backup.');
 const plain=await decryptBackup(arg('--file'),key);
 try{const {child,done}=tool('pg_restore',['--list']);child.stdout.resume();createReadStream(plain.file).pipe(child.stdin);await done;console.log('BACKUP VERIFY PASS: authenticated decryption and PostgreSQL archive validation succeeded.');}finally{await plain.remove();}
}else throw new Error('Use create --output <private-file> or verify --file <encrypted-file>.');

// Destructive commands are restricted to an explicitly named disposable branch.
// No production table is changed and no credentials/row contents are printed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { redactSecrets } from '../security.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const argument=name=>process.argv[process.argv.indexOf(name)+1];
assert.ok(process.argv.includes('--branch')&&process.argv.includes('--connection-file'),'Pass --branch and a private --connection-file.');
const branch=argument('--branch');
assert.match(branch,/^codex-recovery-\d{8}(?:-[a-z0-9]+)?$/,'Only a disposable recovery branch is allowed.');
const context=JSON.parse(await readFile(new URL('../.neon',import.meta.url),'utf8'));
assert.match(context.projectId,/^[a-z0-9-]+$/);
const cli=args=>execFileSync(process.platform==='win32'?process.execPath:'neon',process.platform==='win32'?[process.env.NEON_CLI_ENTRY || join(process.env.APPDATA,'npm','node_modules','neon','dist','cli.js'),...args]:args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const raw=await readFile(argument('--connection-file'),'utf8');
let connectionString=raw.trim();const url=new URL(connectionString);
assert.ok(['postgres:','postgresql:'].includes(url.protocol)&&!url.hostname.includes('-pooler.'),'Use the isolated direct connection.');
const info=JSON.parse(cli(['branches','get',branch,'--project-id',context.projectId,'--output','json']));
const metadata=info.branch||info;
assert.equal(metadata.name,branch);assert.ok(metadata.parent_id,'Never restore the root production branch.');
const expectedConnection = new URL(cli(['connection-string',branch,'--project-id',context.projectId,'--ssl','verify-full']).trim());
assert.equal(url.hostname,expectedConnection.hostname,'Connection file must belong to the selected isolated branch.');
assert.equal(url.pathname,expectedConnection.pathname,'Connection file must select the expected database.');
let pool,stage='connect';
const open=()=>new Pool({connectionString,max:1,connectionTimeoutMillis:15000});
try {
  pool=open();await pool.query('SELECT 1');
  const before=await pool.query('SELECT count(*)::int AS count FROM schema_migrations');
  const marker=randomUUID();stage='write disposable marker';
  await pool.query('CREATE TABLE IF NOT EXISTS public.codex_recovery_probe (id uuid PRIMARY KEY)');
  await pool.query('INSERT INTO public.codex_recovery_probe(id) VALUES ($1)',[marker]);
  const lsn=(await pool.query('SELECT pg_current_wal_lsn()::text AS lsn')).rows[0].lsn;
  assert.match(lsn,/^[0-9A-F]+\/[0-9A-F]+$/i);
  await pool.query('DELETE FROM public.codex_recovery_probe WHERE id=$1',[marker]);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM public.codex_recovery_probe WHERE id=$1',[marker])).rows[0].count,0);
  await pool.end();pool=null;stage='restore isolated branch';
  cli(['branches','restore',branch,`^self@${lsn}`,'--preserve-under-name',branch+'-preserved','--project-id',context.projectId,'--output','json']);
  connectionString=cli(['connection-string',branch,'--project-id',context.projectId,'--ssl','verify-full']).trim();
  stage='verify recovery';let recovered=false;
  for(let attempt=0;attempt<20;attempt++) {
    pool=open();
    try {recovered=(await pool.query('SELECT count(*)::int AS count FROM public.codex_recovery_probe WHERE id=$1',[marker])).rows[0].count===1;if(recovered)break;} catch {}
    await pool.end();pool=null;await delay(1000);
  }
  assert.ok(recovered,'Deleted synthetic marker was not recovered');
  const after=await pool.query('SELECT count(*)::int AS count FROM schema_migrations');
  assert.equal(after.rows[0].count,before.rows[0].count);
  await pool.query('DROP TABLE public.codex_recovery_probe');
  const result={recordedAt:new Date().toISOString(),branch,productionModified:false,
    restoredDeletedSyntheticRow:true,migrationHistoryPreserved:true,migrationCount:after.rows[0].count};
  await writeFile(new URL('../ops/recovery-results.json',import.meta.url),JSON.stringify(result,null,2));
  console.log('RECOVERY PASS: isolated point-in-time restore recovered deleted synthetic data; migration history preserved; production unchanged.');
} catch (error) {
  if (error.stderr) console.error(String(redactSecrets(error.stderr.toString())).slice(0,1200));
  throw new Error(`Recovery rehearsal failed at ${stage}. Inspect private logs without sharing credentials.`);
} finally {await pool?.end();}

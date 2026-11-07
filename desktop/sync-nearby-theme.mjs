import { readFile, writeFile } from 'node:fs/promises';
const page=new URL('../android/app/src/main/assets/nearby/index.html',import.meta.url);
const original=await readFile(page,'utf8'),css=await readFile(new URL('../themes.css',import.meta.url),'utf8'),js=await readFile(new URL('../themes.js',import.meta.url),'utf8');
const diagnostics=(await readFile(new URL('../audio-diagnostics.mjs',import.meta.url),'utf8')).replace(/^export /gm,'');
const updated=original.replace(/(<style data-shared-theme>)[\s\S]*?(\n:root\{--bg:)/,(_,start,end)=>start+css+end).replace(/(<script data-shared-theme>)[\s\S]*?(<\/script><!-- SHARED THEME END -->)/,(_,start,end)=>start+js+end);
const bundled=updated.replace(/(<script data-shared-diagnostics>)[\s\S]*?(<\/script><!-- SHARED DIAGNOSTICS END -->)/,(_,start,end)=>start+diagnostics+end);
if(process.argv.includes('--check')){if(bundled!==original)throw Error('Run node desktop/sync-nearby-theme.mjs to update bundled offline themes.');}
else await writeFile(page,bundled);

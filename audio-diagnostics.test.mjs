import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioDiagnostics } from './audio-diagnostics.mjs';

test('diagnostics use strict allowlists and never export arbitrary strings or identifiers', () => {
  const d = new AudioDiagnostics({ clock: () => 1000 });
  d.record({ connection:'connected',direction:'listener',epoch:2,roomCode:'SECRET',name:'Private',url:'https://secret',token:'token',rms:NaN,output:'https://secret' });
  d.event('socket_closed',{closeCode:1006,reason:'Private token'});
  d.event('https://secret');
  const result = d.export({version:'1.1.13',platform:'web'});
  assert.equal(result.samples[0].epoch,2);
  for (const secret of ['SECRET','Private','https://secret','token']) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.events.find(e=>e.type==='socket_closed').closeCode,1006);
});
test('diagnostics preserve incident events while sampling at one second with bounded memory', () => {
  let now=0;const d=new AudioDiagnostics({clock:()=>now,capacity:3,eventCapacity:4});
  for(let i=0;i<100;i++){now=i*250;d.record({connection:i<5?'connected':'offline',direction:'listener',underruns:i,missingPackets:i});}
  assert.equal(d.samples.length,3);assert.equal(d.events.length,4);
  const exported=d.export();exported.samples[0].underruns=-1;
  assert.notEqual(d.samples[0].underruns,-1);
  assert.ok(d.events.some(e=>e.type==='underrun'));
});

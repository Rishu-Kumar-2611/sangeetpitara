import test from 'node:test';
import assert from 'node:assert/strict';
import { upperHealth, bufferHealth, RecentCounter } from './stream-health.mjs';
test('thresholds mark unknown, ideal, tolerable and poor values honestly',()=>{
 assert.equal(upperHealth(undefined,20,60),'pending');
 assert.equal(upperHealth(20,20,60),'good');
 assert.equal(upperHealth(21,20,60),'warning');
 assert.equal(upperHealth(61,20,60),'bad');
 assert.equal(bufferHealth(1000,1000,false),'good');
 assert.equal(bufferHealth(600,1000,false),'warning');
 assert.equal(bufferHealth(0,1000,true),'bad');
});
test('recent counters recover after 60 seconds and reset on source counter reset',()=>{
 const c=new RecentCounter();c.update(10,0);assert.equal(c.update(11,1),1);
 assert.equal(c.update(11,60001),0);c.update(12,60002);
 assert.equal(c.update(0,60003),0);
});

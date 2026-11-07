import test from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress } from './client-address.mjs';
const request = value => ({socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':value}});
test('untrusted forwarding headers never replace the socket address',()=>{
 assert.equal(clientAddress(request('198.51.100.1'),{}),'127.0.0.1');
});
test('trusted hop selection ignores attacker-controlled leading addresses',()=>{
 assert.equal(clientAddress(request('198.51.100.1, 203.0.113.9'),{TRUST_PROXY:'1'}),'203.0.113.9');
 assert.equal(clientAddress(request('spoof, 198.51.100.7, 203.0.113.9'),{TRUST_PROXY:'1',TRUST_PROXY_HOPS:'2'}),'198.51.100.7');
 for(const value of ['not-an-ip','', 'x'.repeat(1025)])assert.equal(clientAddress(request(value),{TRUST_PROXY:'1'}),'127.0.0.1');
 assert.equal(clientAddress(request('198.51.100.1'),{TRUST_PROXY:'1',TRUST_PROXY_HOPS:'-1'}),'127.0.0.1');
});

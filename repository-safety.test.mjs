import test from 'node:test';
import assert from 'node:assert/strict';
import { privateRepositoryPaths } from './checks/repository-safety.mjs';
test('repository guard rejects secret containers while permitting explicit examples and test fixtures',()=>{
 const forbidden=['.env','.env.local','.private-migration/url.txt','android/release.jks','backup.sgb','SangeetPitara-audio-diagnostics.json'];
 assert.deepEqual(privateRepositoryPaths([...forbidden,'.env.example','ops/env.production.example','desktop/test-fixtures/test-only-key.pem','audio-diagnostics.mjs']),forbidden);
});

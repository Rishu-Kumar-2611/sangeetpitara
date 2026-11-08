import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVoice, chatContent, boundVoiceHistory, chatSnapshot, VOICE_MAX_BYTES } from './chat-content.mjs';
const clip = () => ({mimeType:'audio/mp4',durationMs:1000,data:Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(16)]).toString('base64')});
test('voice notes validate size, duration, encoding and container signature',()=>{
 assert.equal(validateVoice(clip()).mimeType,'audio/mp4');
 for(const bad of [{...clip(),mimeType:'text/html'},{...clip(),durationMs:30001},{...clip(),data:Buffer.alloc(VOICE_MAX_BYTES+1).toString('base64')},{...clip(),data:Buffer.from('<script>alert(1)</script>').toString('base64')},{...clip(),data:clip().data+'!'}])assert.throws(()=>validateVoice(bad));
});
test('reply quotes come from room history and never from a supplied sender or audio body',()=>{
 const message={id:'one',kind:'chat',senderName:'Friend',text:'Original message',voice:clip()};
 const result=chatContent({text:'Reply',replyToId:'one',replyTo:{senderName:'Spoof'}},[message]);
 assert.deepEqual(result.replyTo,{id:'one',senderName:'Friend',text:'Voice message'});
 assert.throws(()=>chatContent({text:'Reply',replyToId:'another-room'},[message]));
 assert.throws(()=>chatContent({},[]));
});
test('voice memory limits expire oldest data while retaining message and reply metadata',()=>{
 const a={messages:[{id:'a',createdAt:1,voice:clip()},{id:'b',createdAt:2,voice:clip()}]};
 const b={messages:[{id:'c',createdAt:3,voice:clip()}]};
 const size=Buffer.byteLength(clip().data,'base64');
 const expired=boundVoiceHistory([a,b],size,size);
 assert.deepEqual(expired.map(e=>e.message.id),['a','b']);
 assert.equal(a.messages[0].voice.unavailable,true);assert.equal(a.messages[0].voice.data,undefined);assert.ok(b.messages[0].voice.data);
});

test('routine room updates reference recordings without resending their bytes',()=>{
 const message={id:'voice',voice:clip()};const lightweight=chatSnapshot(message,false);
 assert.equal(lightweight.voice.data,undefined);assert.equal(lightweight.voice.referenceOnly,true);
 assert.equal(chatSnapshot(message,true).voice.data,message.voice.data);
});

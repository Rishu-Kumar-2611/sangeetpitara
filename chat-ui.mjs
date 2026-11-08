const make = (tag, cls, text) => { const el=document.createElement(tag); if(cls)el.className=cls; if(text!=null)el.textContent=text; return el; };
const button = (text, action, cls='secondary-button') => { const el=make('button',cls,text);el.type='button';el.addEventListener('click',action);return el; };
export class RoomChatUI {
  constructor({feed,input,form,send,getMessages,getSelfId,onError}) {
    Object.assign(this,{feed,input,form,send,getMessages,getSelfId,onError}); this.urls=new Map(); this.nodes=new Map(); this.generation=0;
    this.reply=make('div','chat-reply-composer');this.reply.hidden=true;form.before(this.reply);
    this.preview=make('div','chat-voice-preview');this.preview.hidden=true;form.before(this.preview);
    this.tools=make('div','chat-tools');this.recordButton=button('Record voice',()=>this.toggleRecording(),'ghost-button');this.tools.append(this.recordButton);form.after(this.tools);
    this.feed.addEventListener('play',e=>{if(e.target.tagName==='AUDIO')for(const audio of this.feed.querySelectorAll('audio'))if(audio!==e.target)audio.pause();},true);
    this.hideHandler=()=>{if(document.hidden)this.cancelRecording();};document.addEventListener('visibilitychange',this.hideHandler);
    this.pageHandler=()=>this.reset();addEventListener('pagehide',this.pageHandler);
    if(!globalThis.isSecureContext||!navigator.mediaDevices?.getUserMedia||!globalThis.MediaRecorder) {this.recordButton.disabled=true;this.recordButton.title='Voice recording needs HTTPS or the desktop companion. You can still listen and reply.';this.tools.append(make('small','','Recording needs HTTPS or the desktop companion.'));}
  }
  selectReply(message) {
    this.replyId=message.id;this.reply.hidden=false;this.reply.replaceChildren();
    const copy=make('div');copy.append(make('strong','',`Replying to ${message.senderName||'Room'}`),make('span','',message.voice?'Voice message':message.text));
    this.reply.append(copy,button('Cancel reply',()=>this.clearReply(),'ghost-button'));this.input.focus();
  }
  clearReply(){this.replyId=null;this.reply.hidden=true;this.reply.replaceChildren();}
  payload(content){return {...content,...(this.replyId?{replyToId:this.replyId}:{})};}
  render(messages,reactions){
    const near=this.feed.scrollHeight-this.feed.scrollTop-this.feed.clientHeight<64;const ids=new Set(messages.map(m=>m.id));
    for(const [id,node] of this.nodes)if(!ids.has(id)){node.remove();this.nodes.delete(id);this.releaseUrl(id);}
    this.feed.querySelector('.request-empty')?.remove();
    if(!messages.length)this.feed.append(make('p','request-empty','Start the conversation with the room.'));
    for(const message of messages){
      if(this.pendingId&&message.clientMessageId===this.pendingId&&message.senderId===this.getSelfId()){this.pendingId=null;clearTimeout(this.ackTimer);this.discardDraft();this.clearReply();}
      let node=this.nodes.get(message.id);
      if(!node){
        node=make('article','chat-message');node.dataset.messageId=message.id;node.id=`chat-${message.id}`;
        const body=make('div','chat-body');const meta=make('div','chat-meta');meta.append(make('strong','chat-name',message.senderName||'Room'),make('time','chat-time',new Date(message.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})));
        body.append(meta);
        if(message.replyTo){const quote=button(`${message.replyTo.senderName||'Room'}: ${message.replyTo.text}`,()=>{const target=this.nodes.get(message.replyTo.id);if(target){target.scrollIntoView({block:'nearest',behavior:'smooth'});target.setAttribute('tabindex','-1');target.focus({preventScroll:true});}else this.onError('The original message is no longer in this room history.');},'chat-quote');body.append(quote);}
        const content=make('div','chat-content');body.append(content);
        if(!message.voice)content.append(make('div','chat-text',message.text));
        body.append(button('Reply',()=>this.selectReply(message),'chat-reply-button'),make('div','chat-message-reactions'));node.append(body);this.nodes.set(message.id,node);this.feed.append(node);
      }
      if(message.voice){
        const content=node.querySelector('.chat-content');
        if(message.voice.data&&!this.urls.has(message.id)){
          try {const bytes=Uint8Array.from(atob(message.voice.data),c=>c.charCodeAt(0));if(bytes.length>192*1024)throw Error();const url=URL.createObjectURL(new Blob([bytes],{type:message.voice.mimeType}));this.urls.set(message.id,url);const audio=make('audio','chat-voice-player');audio.controls=true;audio.preload='none';audio.src=url;audio.setAttribute('aria-label',`Voice message from ${message.senderName}`);content.replaceChildren(audio,make('small','',`Voice message · ${Math.ceil(message.voice.durationMs/1000)} sec`));}catch{content.replaceChildren(make('p','','This recording could not be opened.'));}
        }else if(!message.voice.data){this.releaseUrl(message.id);content.replaceChildren(make('p','chat-unavailable','Recording is no longer available.'));}
      }
      if(reactions)node.querySelector('.chat-message-reactions').innerHTML=reactions(message);
    }
    if(near)this.feed.scrollTop=this.feed.scrollHeight;
  }
  releaseUrl(id){const url=this.urls.get(id);if(url){URL.revokeObjectURL(url);this.urls.delete(id);}}
  async toggleRecording(){
    if(this.recorder?.state==='recording'){this.recorder.stop();return;}
    if(this.draft){this.showDraft();return;}
    if(this.requesting)return;this.requesting=true;const generation=++this.generation;
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
      if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());return;}
      const mimeType=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
      if(!mimeType){stream.getTracks().forEach(t=>t.stop());throw Error('Voice recording is not supported in this browser.');}
      this.stream=stream;this.chunks=[];this.bytes=0;this.cancelled=false;this.started=performance.now();
      this.recorder=new MediaRecorder(stream,{mimeType,audioBitsPerSecond:24000});
      this.recorder.ondataavailable=e=>{if(this.cancelled)return;if(e.data.size){this.bytes+=e.data.size;this.chunks.push(e.data);if(this.bytes>192*1024){this.cancelled=true;if(this.recorder.state==='recording')this.recorder.stop();this.onError('Recording is too large. Try a shorter voice note.');}}};
      this.recorder.onerror=()=>{this.cancelled=true;if(this.recorder.state==='recording')this.recorder.stop();this.onError('The microphone recording failed. Please try again.');};
      this.recorder.onstop=async()=>{
        clearInterval(this.recordTimer);stream.getTracks().forEach(t=>t.stop());this.stream=null;this.recordButton.textContent='Record voice';this.preview.hidden=true;
        const chunks=this.chunks;this.chunks=[];
        if(this.cancelled||generation!==this.generation)return;
        const blob=new Blob(chunks,{type:mimeType}),durationMs=Math.min(30000,Math.round(performance.now()-this.started));
        if(durationMs<200||blob.size<12||blob.size>192*1024)return this.onError('Please record between 1 and 30 seconds.');
        const bytes=new Uint8Array(await blob.arrayBuffer());if(generation!==this.generation)return;
        let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
        this.draft={data:btoa(binary),mimeType,durationMs};this.draftId=Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');this.draftUrl=URL.createObjectURL(blob);this.showDraft();
      };
      this.recorder.start(250);this.preview.hidden=false;const label=make('span');label.setAttribute('role','status');this.preview.replaceChildren(label,button('Discard',()=>this.cancelRecording()));
      const tick=()=>{const elapsed=Math.round((performance.now()-this.started)/1000);label.textContent=`Recording ${Math.min(30,elapsed)} / 30 sec`;if(elapsed>=30&&this.recorder.state==='recording')this.recorder.stop();};
      tick();this.recordTimer=setInterval(tick,250);this.recordButton.textContent='Stop recording';
    }catch(error){this.stream?.getTracks().forEach(t=>t.stop());this.onError(error.name==='NotAllowedError'?'Microphone access was denied. You can still send text messages.':error.message||'The microphone is unavailable.');}
    finally {this.requesting=false;}
  }
  showDraft(){
    this.preview.hidden=false;const audio=make('audio','chat-voice-player');audio.controls=true;audio.src=this.draftUrl;audio.preload='metadata';
    this.preview.replaceChildren(audio,button('Send voice',()=>this.sendDraft(),'primary-button'),button('Discard',()=>this.discardDraft()));
    this.recordButton.textContent='Review voice';
  }
  sendDraft(){
    if(!this.draft||this.pendingId)return;
    if(this.send(this.payload({type:'chat',voice:this.draft,clientMessageId:this.draftId}))===false)return;
    this.pendingId=this.draftId;this.preview.querySelector('button').disabled=true;
    this.ackTimer=setTimeout(()=>{this.pendingId=null;if(this.draft){this.showDraft();this.onError('Sending was not confirmed. Reconnect and retry; the recording is still here.');}},15000);
  }
  sendFailed(){if(this.pendingId){clearTimeout(this.ackTimer);this.pendingId=null;if(this.draft)this.showDraft();}}
  cancelRecording(){++this.generation;this.cancelled=true;clearInterval(this.recordTimer);if(this.recorder?.state==='recording')this.recorder.stop();this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;if(!this.draft)this.preview.hidden=true;this.recordButton.textContent=this.draft?'Review voice':'Record voice';}
  discardDraft(){if(this.draftUrl)URL.revokeObjectURL(this.draftUrl);this.draftUrl=null;this.draft=null;this.preview.hidden=true;this.preview.replaceChildren();this.recordButton.textContent='Record voice';}
  reset(){this.cancelRecording();clearTimeout(this.ackTimer);this.pendingId=null;this.discardDraft();this.clearReply();for(const id of this.urls.keys())this.releaseUrl(id);this.nodes.clear();this.feed.replaceChildren();}
}

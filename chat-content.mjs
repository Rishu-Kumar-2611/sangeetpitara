export const VOICE_MAX_BYTES = 192 * 1024;
export const VOICE_MAX_DURATION_MS = 30_000;
const formats = new Map([['audio/webm', 'webm'], ['audio/webm;codecs=opus', 'webm'], ['audio/ogg', 'ogg'], ['audio/ogg;codecs=opus', 'ogg'], ['audio/mp4', 'mp4']]);
export function validateVoice(input) {
  if (!input || typeof input !== 'object') throw Error('Invalid voice message.');
  const mimeType = String(input.mimeType || '').toLowerCase().replaceAll(' ', '');
  const format = formats.get(mimeType);
  const { data, durationMs } = input;
  if (!format || typeof data !== 'string' || data.length > Math.ceil(VOICE_MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error('Unsupported or oversized voice message.');
  if (!Number.isFinite(durationMs) || durationMs < 200 || durationMs > VOICE_MAX_DURATION_MS) throw Error('Voice messages must be between 0.2 and 30 seconds.');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length < 12 || bytes.length > VOICE_MAX_BYTES || bytes.toString('base64') !== data) throw Error('Invalid voice data.');
  const signature = format === 'webm' ? bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) : format === 'ogg' ? bytes.toString('ascii',0,4) === 'OggS' : bytes.toString('ascii',4,8) === 'ftyp';
  if (!signature) throw Error('The recording does not match its audio format.');
  return { data, mimeType, durationMs: Math.round(durationMs) };
}
const limitedText = (value, max) => Array.from(value).reduce((text, char) => text.length + char.length <= max ? text + char : text, '');
export function chatContent(input, messages) {
  const text = typeof input.text === 'string' ? limitedText(input.text.replace(/[\u0000-\u001f\u007f]/g, '').trim(),280) : '';
  const voice = input.voice == null ? null : validateVoice(input.voice);
  if (!text && !voice) throw Error('Write a message or record a voice note first.');
  let replyTo;
  if (input.replyToId != null) {
    const target = messages.find(m => m.kind === 'chat' && m.id === input.replyToId);
    if (!target) throw Error('That message is no longer in this room history.');
    replyTo = { id: target.id, senderName: target.senderName, text: target.voice ? 'Voice message' : limitedText(target.text,160) };
  }
  return { text: text || 'Voice message', ...(voice ? { voice } : {}), ...(replyTo ? { replyTo } : {}) };
}
// Bound server memory globally and per room; quotes never duplicate recordings.
export function boundVoiceHistory(rooms, perRoomBytes = 512 * 1024, totalBytes = 16 * 1024 * 1024) {
  const expired = [], candidates = []; let total = 0;
  const expire = item => { delete item.message.voice.data; item.message.voice.unavailable = true; total -= item.size; expired.push(item); };
  for (const room of rooms) {
    const clips = room.messages.filter(m => m.voice?.data).map(message => ({ room, message, size: Buffer.byteLength(message.voice.data, 'base64') }));
    let size = clips.reduce((n,c) => n+c.size,0); total += size;
    for (const clip of clips) { if (size > perRoomBytes) { expire(clip); size -= clip.size; } else candidates.push(clip); }
  }
  for (const clip of candidates.sort((a,b)=>a.message.createdAt-b.message.createdAt)) { if (total <= totalBytes) break; expire(clip); }
  return expired;
}
export function chatSnapshot(message, includeVoiceData = true) {
  if (includeVoiceData || !message.voice?.data) return message;
  const { data, ...voice } = message.voice;
  return { ...message, voice: { ...voice, referenceOnly: true } };
}

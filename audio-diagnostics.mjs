// Explicit allowlists: diagnostics never accept names, URLs, identifiers, audio,
// chat, arbitrary errors, or capture content. Nothing is sent to a server.
const NUMBERS = new Set(['epoch','sentPackets','receivedPackets','missingPackets','underruns','bufferMs','targetMs','jitterMs','queueMs','packetAgeMs','rms','peak','reconnects','closeCode']);
const ENUMS = {
  mode: ['internet','nearby'], direction: ['sender','listener','idle'],
  connection: ['connected','connecting','offline'],
  output: ['running','suspended','closed','unavailable'],
};
const EVENTS = new Set(['started','connection_changed','source_changed','output_changed','underrun','sequence_gap','socket_closed','exported']);
export class AudioDiagnostics {
  constructor({ clock = Date.now, capacity = 300, eventCapacity = 120 } = {}) {
    this.clock = clock;
    this.capacity = Math.max(1, Math.min(600, Math.trunc(capacity) || 300));
    this.eventCapacity = Math.max(1, Math.min(200, Math.trunc(eventCapacity) || 120));
    this.samples = []; this.events = []; this.previous = null; this.lastSample = -Infinity;
  }
  event(type, fields = {}) {
    if (!EVENTS.has(type)) return;
    const record = { at: this.clock(), type };
    if (Number.isInteger(fields.closeCode) && fields.closeCode >= 0 && fields.closeCode <= 4999) record.closeCode = fields.closeCode;
    if (Number.isFinite(fields.count) && fields.count >= 0) record.count = Math.min(1e12, Math.trunc(fields.count));
    this.events.push(record);
    if (this.events.length > this.eventCapacity) this.events.splice(0, this.events.length - this.eventCapacity);
  }
  record(input) {
    const sample = { at: this.clock() };
    for (const key of NUMBERS) if (Number.isFinite(input[key]) && input[key] >= 0) sample[key] = Math.min(input[key], 1e12);
    for (const [key, values] of Object.entries(ENUMS)) if (values.includes(input[key])) sample[key] = input[key];
    if (typeof input.refilling === 'boolean') sample.refilling = input.refilling;
    const previous = this.previous;
    if (!previous) this.event('started');
    else {
      if (sample.connection !== previous.connection) this.event('connection_changed');
      if (sample.direction !== previous.direction || sample.epoch !== previous.epoch) this.event('source_changed');
      if (sample.output !== previous.output) this.event('output_changed');
      for (const [key, type] of [['underruns','underrun'],['missingPackets','sequence_gap']]) {
        if (Number.isFinite(previous[key]) && sample[key] > previous[key]) this.event(type, { count: sample[key] - previous[key] });
      }
    }
    this.previous = sample;
    if (sample.at - this.lastSample >= 1000 || sample.at < this.lastSample) {
      this.lastSample = sample.at; this.samples.push(sample);
      if (this.samples.length > this.capacity) this.samples.splice(0, this.samples.length - this.capacity);
    }
    return sample;
  }
  export({ platform = 'web', version = 'development' } = {}) {
    this.event('exported');
    return {
      schemaVersion: 1, generatedAt: new Date(this.clock()).toISOString(),
      platform: ['web','android','nearby-web'].includes(platform) ? platform : 'web',
      version: typeof version === 'string' && version.length <= 24 && /^\d+\.\d+\.\d+$/.test(version) ? version : 'development',
      privacy: 'Local measurements only. No audio, names, chat, room codes, IPs, URLs, or credentials.',
      limitations: 'Packet submission is not speaker delivery. End-to-end delay, radio strength and acoustic fidelity are not measured.',
      samples: this.samples.map(s => ({ ...s })), events: this.events.map(e => ({ ...e })),
    };
  }
}

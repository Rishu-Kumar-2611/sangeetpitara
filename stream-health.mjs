// App operating thresholds, not a measurement of perceived fidelity or end-to-end latency.
export function upperHealth(value, ideal, tolerable) {
  if (!Number.isFinite(value) || value < 0) return 'pending';
  return value <= ideal ? 'good' : value <= tolerable ? 'warning' : 'bad';
}
export function bufferHealth(buffered, target, refilling) {
  if (!Number.isFinite(buffered) || !Number.isFinite(target) || target <= 0) return 'pending';
  if (refilling || buffered <= 0) return 'bad';
  const margin = Math.max(20, target * .25);
  return Math.abs(buffered - target) <= margin ? 'good' : buffered >= target * .5 ? 'warning' : 'bad';
}
export class RecentCounter {
  constructor(windowMs = 60000) { this.windowMs = windowMs; this.events = []; this.previous = null; }
  update(total, now = Date.now()) {
    if (this.previous !== null && total >= this.previous && total > this.previous) this.events.push([now, total - this.previous]);
    if (this.previous !== null && total < this.previous) this.events = [];
    this.previous = total;
    this.events = this.events.filter(([at]) => now - at < this.windowMs);
    return this.events.reduce((sum, [, n]) => sum + n, 0);
  }
  reset() { this.events = []; this.previous = null; }
}

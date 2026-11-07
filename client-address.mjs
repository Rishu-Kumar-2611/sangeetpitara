import { isIP } from 'node:net';

// Count trusted proxy hops from the server outward, never blindly trust the
// attacker-controlled first XFF entry. Only enable behind an isolated proxy.
export function clientAddress(request, env = process.env) {
  const peer = request.socket?.remoteAddress || 'unknown';
  if (!['1','true'].includes(String(env.TRUST_PROXY))) return peer;
  const hops = Number(env.TRUST_PROXY_HOPS || 1);
  if (!Number.isInteger(hops) || hops < 1 || hops > 8) return peer;
  const value = request.headers?.['x-forwarded-for'];
  if (typeof value !== 'string' || value.length > 1024) return peer;
  const chain = value.split(',').map(s => s.trim());
  if (chain.length < hops || chain.length > 32) return peer;
  const selected = chain.at(-hops);
  return isIP(selected) ? selected : peer;
}

// Per-room aura colours. Each room code hashes to two hues; each hue gets the
// lightest HSL value whose WCAG luminance stays at or under the ceiling below,
// so body and secondary text keep >= 4.5:1 on any aura pixel.

export const AURA_SATURATION = 72;
// Secondary text (#C4B6A7, luminance ~0.47) needs (0.47 + 0.05) / (L + 0.05) >= 4.5.
export const AURA_MAX_LUMINANCE = 0.06;
export const BRAND_PALETTE = Object.freeze({ hue1: 36, hue2: 173 });

function channelToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function hslToRgb(hue, saturation, lightness) {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((value) => Math.round(value * 255));
}

export function relativeLuminance([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map((value) => channelToLinear(value / 255));
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

export function contrastRatio(a, b) {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Lightest lightness (whole percent, <= 46) that keeps the hue under the luminance ceiling. */
export function clampedLightness(hue, saturation = AURA_SATURATION, maxLuminance = AURA_MAX_LUMINANCE) {
  for (let lightness = 46; lightness > 0; lightness -= 1) {
    if (relativeLuminance(hslToRgb(hue, saturation, lightness)) <= maxLuminance) return lightness;
  }
  return 0;
}

function hashCode(text) {
  // FNV-1a: stable across browsers and sessions.
  let hash = 0x811c9dc5;
  for (const char of String(text || '').toUpperCase()) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function describe(hue1, hue2) {
  const light1 = clampedLightness(hue1);
  const light2 = clampedLightness(hue2);
  return {
    hue1,
    hue2,
    color1: `hsl(${hue1} ${AURA_SATURATION}% ${light1}%)`,
    color2: `hsl(${hue2} ${AURA_SATURATION}% ${light2}%)`,
    rgb1: hslToRgb(hue1, AURA_SATURATION, light1),
    rgb2: hslToRgb(hue2, AURA_SATURATION, light2),
  };
}

/** Deterministic colour pair for a room code; the second hue sits 40-140 degrees away. */
export function roomPalette(code) {
  const hash = hashCode(code);
  const hue1 = hash % 360;
  const hue2 = (hue1 + 40 + ((hash >>> 12) % 101)) % 360;
  return describe(hue1, hue2);
}

export function brandPalette() {
  return describe(BRAND_PALETTE.hue1, BRAND_PALETTE.hue2);
}

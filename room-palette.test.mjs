import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AURA_MAX_LUMINANCE,
  AURA_SATURATION,
  brandPalette,
  clampedLightness,
  contrastRatio,
  hslToRgb,
  relativeLuminance,
  roomPalette,
} from './room-palette.js';

const text = [0xF7, 0xF1, 0xEA]; // --text
const muted = [0xC4, 0xB6, 0xA7]; // --muted

test('room palettes are deterministic, case-insensitive and differ between rooms', () => {
  assert.deepEqual(roomPalette('ABC123'), roomPalette('ABC123'));
  assert.deepEqual(roomPalette('abc123'), roomPalette('ABC123'));
  const hues = new Set(['ABC123', 'ZZZ999', 'K7Q2PX', 'MOVIE1', 'Q4W8E2'].map((code) => roomPalette(code).hue1));
  assert.ok(hues.size >= 4, 'different codes spread across the wheel');
  for (const code of ['ABC123', 'ZZZ999', 'K7Q2PX']) {
    const { hue1, hue2 } = roomPalette(code);
    const gap = (hue2 - hue1 + 360) % 360;
    assert.ok(gap >= 40 && gap <= 140, `${code}: hues ${hue1}/${hue2} stay distinct`);
  }
});

test('every aura hue is clamped so text and secondary text keep 4.5:1 contrast', () => {
  for (let hue = 0; hue < 360; hue += 1) {
    const rgb = hslToRgb(hue, AURA_SATURATION, clampedLightness(hue));
    assert.ok(relativeLuminance(rgb) <= AURA_MAX_LUMINANCE, `hue ${hue}`);
    assert.ok(contrastRatio(text, rgb) >= 4.5, `text on hue ${hue}`);
    assert.ok(contrastRatio(muted, rgb) >= 4.5, `muted on hue ${hue}`);
  }
});

test('brand palette is marigold and teal and matches the CSS defaults', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('styles.css', import.meta.url), 'utf8');
  const brand = brandPalette();
  assert.equal(brand.hue1, 36);
  assert.equal(brand.hue2, 173);
  assert.ok(css.includes(`--room-color-1: ${brand.color1};`));
  assert.ok(css.includes(`--room-color-2: ${brand.color2};`));
  assert.ok(css.includes(`initial-value: ${brand.color1};`));
  assert.ok(css.includes(`initial-value: ${brand.color2};`));
});

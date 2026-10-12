import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';

let composer = {};
try {
  composer = await import('./discord-comparison-image.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('discord-comparison-image.mjs')) throw error;
}

async function solid(red, green, blue) {
  return sharp({ create: { width: 160, height: 100, channels: 3, background: { r: red, g: green, b: blue } } }).png().toBuffer();
}

async function noise(seed) {
  const data = Buffer.alloc(420 * 250 * 3);
  let state = seed;
  for (let index = 0; index < data.length; index++) {
    state = (Math.imul(1664525, state) + 1013904223) | 0;
    data[index] = state >>> 24;
  }
  return sharp(data, { raw: { width: 420, height: 250, channels: 3 } }).png().toBuffer();
}

async function decoded(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, ...info };
}

function pixel(image, x, y) {
  const offset = (image.width * y + x) * image.channels;
  return [...image.data.subarray(offset, offset + 3)];
}

function nearColor(actual, expected) {
  assert.ok(actual.every((channel, index) => Math.abs(channel - expected[index]) <= 12), `${actual} should resemble ${expected}`);
}

// Catches a missing composer, reversed panels, omitted image content, or a non-WebP attachment.
test('renders the original on the left and replacement on the right as a bounded WebP attachment', async () => {
  assert.equal(typeof composer.composeComparisonImage, 'function', 'The comparison-image composer must be available');
  const original = await solid(255, 0, 0);
  const replacement = await solid(0, 0, 255);
  const output = await composer.composeComparisonImage({
    originals: [{ name: 'Classic Chou', image: 'fixture:original' }],
    replacement: { name: 'Updated Chou', image: 'fixture:replacement' },
  }, { loadImage: async url => ({ 'fixture:original': original, 'fixture:replacement': replacement })[url] ?? null });
  assert.ok(Buffer.isBuffer(output));
  assert.ok(output.length > 0 && output.length <= 1_000_000);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'webp');
  assert.ok(metadata.width >= 800 && metadata.width <= 1080);
  assert.ok(metadata.height >= 350 && metadata.height <= 500);
  const image = await decoded(output);
  nearColor(pixel(image, 240, 180), [255, 0, 0]);
  nearColor(pixel(image, 750, 180), [0, 0, 255]);
});

// Catches omission or reordering of originals and using another original as the replacement.
test('keeps each changed original in input order opposite the same replacement', async () => {
  const red = await solid(255, 0, 0);
  const green = await solid(0, 255, 0);
  const yellow = await solid(255, 255, 0);
  const blue = await solid(0, 0, 255);
  const output = await composer.composeComparisonImage({
    originals: [
      { name: 'First original', image: 'first' },
      { name: 'Second original', image: 'second' },
      { name: 'Third original', image: 'third' },
    ],
    replacement: { name: 'One replacement', image: 'replacement' },
  }, { loadImage: async url => ({ first: red, second: green, third: yellow, replacement: blue })[url] });
  const image = await decoded(output);
  assert.ok(image.height >= 1100 && image.height <= 1400, 'Three readable comparison rows must be present');
  for (const [row, color] of [[0, [255, 0, 0]], [1, [0, 255, 0]], [2, [255, 255, 0]]]) {
    nearColor(pixel(image, 240, row * 410 + 180), color);
    nearColor(pixel(image, 750, row * 410 + 180), [0, 0, 255]);
  }
});

// Catches unbounded rows/loading and an omitted overflow explanation in the attachment itself.
test('shows at most eight originals with a readable overflow footer', async () => {
  const red = await solid(255, 0, 0);
  const blue = await solid(0, 0, 255);
  const loaded = [];
  const output = await composer.composeComparisonImage({
    originals: Array.from({ length: 11 }, (_, index) => ({ name: `Original ${index + 1}`, image: `original-${index}` })),
    replacement: { name: 'Replacement', image: 'replacement' },
  }, { loadImage: async url => { loaded.push(url); return url === 'replacement' ? blue : red; } });
  const image = await decoded(output);
  assert.ok(image.height >= 3300 && image.height <= 3400, 'Eight rows and the overflow footer fit the attachment');
  nearColor(pixel(image, 240, 7 * 410 + 180), [255, 0, 0]);
  nearColor(pixel(image, 750, 7 * 410 + 180), [0, 0, 255]);
  assert.ok(!loaded.some(url => /^original-(8|9|10)$/.test(url)), 'Hidden originals should not be loaded');
  let footerInk = 0;
  for (let y = image.height - 65; y < image.height - 10; y++) {
    for (let x = 180; x < 820; x++) {
      if (pixel(image, x, y).every(channel => channel > 140)) footerInk++;
    }
  }
  assert.ok(footerInk > 500, 'The footer must contain visible, readable text');
  assert.ok(output.length <= 1_000_000);
});

// Catches guessing an original preview from the replacement or leaving an empty, unexplained panel.
test('renders a visibly labeled unavailable preview without inventing an original image', async () => {
  const blue = await solid(0, 0, 255);
  let output;
  await assert.doesNotReject(async () => {
    output = await composer.composeComparisonImage({
      originals: [{ name: 'Original without a preview' }],
      replacement: { name: 'Replacement', image: 'replacement' },
    }, { loadImage: async url => url === 'replacement' ? blue : null });
  });
  const image = await decoded(output);
  nearColor(pixel(image, 40, 80), [29, 41, 59]);
  nearColor(pixel(image, 750, 180), [0, 0, 255]);
  let placeholderInk = 0;
  for (let y = 160; y < 210; y++) {
    for (let x = 85; x < 410; x++) {
      if (pixel(image, x, y).every(channel => channel > 140)) placeholderInk++;
    }
  }
  assert.ok(placeholderInk > 500, 'The unavailable panel must explain itself with readable text');
});

// Catches failed loads or corrupt files escaping instead of showing the same honest unavailable panel.
test('uses the unavailable panel for missing, unreadable, and failed image loads', async () => {
  const pair = { originals: [{ name: 'Original', image: 'unavailable' }], replacement: { name: 'Replacement', image: 'unavailable' } };
  let missing;
  await assert.doesNotReject(async () => { missing = await composer.composeComparisonImage(pair); });
  for (const loadImage of [async () => null, async () => Buffer.from('not an image'), async () => { throw new Error('Fixture load failure'); }]) {
    let output;
    await assert.doesNotReject(async () => { output = await composer.composeComparisonImage(pair, { loadImage }); });
    assert.ok(output.equals(missing), 'An unavailable image must have the same honest placeholder regardless of why it was unavailable');
  }
});

// Catches decoding oversized compressed images or accepting a huge downloader result.
test('refuses image byte and decompression sizes beyond the preview limits', async () => {
  const pair = { originals: [{ name: 'Original', image: 'bounded' }], replacement: { name: 'Replacement', image: 'bounded' } };
  const missing = await composer.composeComparisonImage(pair);
  const tooManyPixels = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const tooManyBytes = Buffer.concat([await solid(255, 0, 0), Buffer.alloc(8 * 1024 * 1024 + 1)]);
  for (const bytes of [tooManyPixels, tooManyBytes]) {
    let output;
    await assert.doesNotReject(async () => { output = await composer.composeComparisonImage(pair, { loadImage: async () => bytes }); });
    assert.ok(output.equals(missing), 'Oversized inputs must be represented as unavailable');
  }
});

// Catches decoding arbitrary SVG input, which can refer to external resources instead of bounded raster pixels.
test('treats non-raster downloaded image input as unavailable', async () => {
  const pair = { originals: [{ name: 'Original', image: 'svg' }], replacement: { name: 'Replacement', image: 'svg' } };
  const missing = await composer.composeComparisonImage(pair);
  const svg = Buffer.from('<svg width="160" height="100" xmlns="http://www.w3.org/2000/svg"><rect width="160" height="100" fill="red"/></svg>');
  const output = await composer.composeComparisonImage(pair, { loadImage: async () => svg });
  assert.ok(output.equals(missing), 'Non-raster input must produce the unavailable panel');
});

// Catches long names painting across the arrow/other panel or being shrunk to illegible text.
test('wraps and ellipsizes very long labels inside their own panels at readable size', async () => {
  const red = await solid(255, 0, 0);
  const blue = await solid(0, 0, 255);
  const output = await composer.composeComparisonImage({
    originals: [{ name: 'W'.repeat(1200), image: 'original' }],
    replacement: { name: 'Wind & Water <literal> "quoted" ' + '長'.repeat(300), image: 'replacement' },
  }, { loadImage: async url => url === 'original' ? red : blue });
  const image = await decoded(output);
  let gapInk = 0;
  let lowerLineInk = 0;
  for (let y = 330; y < 395; y++) {
    for (let x = 463; x < 538; x++) {
      if (pixel(image, x, y).every(channel => channel > 140)) gapInk++;
    }
    if (y >= 357) {
      for (let x = 32; x < 452; x++) {
        if (pixel(image, x, y).every(channel => channel > 140)) lowerLineInk++;
      }
    }
  }
  assert.equal(gapInk, 0, 'An original label must not spill into the arrow or replacement column');
  assert.ok(lowerLineInk > 300, 'Long text must wrap to a second readable line');
  assert.ok(output.length <= 1_000_000);
});

// Catches markup escaping or XML-control sanitization failures that alter the artwork or break rendering.
test('renders labels as literal text even with markup, XML controls, and malformed Unicode', async () => {
  const red = await solid(255, 0, 0);
  const blue = await solid(0, 0, 255);
  let output;
  await assert.doesNotReject(async () => {
    output = await composer.composeComparisonImage({
      originals: [{ name: '</text><rect width="1000" height="410" fill="lime"/> & \u0000 \u0001 \ud800', image: 'original' }],
      replacement: { name: 'Replacement & <safe> "name"', image: 'replacement' },
    }, { loadImage: async url => url === 'original' ? red : blue });
  });
  const image = await decoded(output);
  nearColor(pixel(image, 240, 180), [255, 0, 0]);
  nearColor(pixel(image, 750, 180), [0, 0, 255]);
});

// Catches a fixed-quality encoder emitting a larger-than-allowed attachment for detailed catalog previews.
test('keeps eight detailed comparison rows below one megabyte without shrinking readable labels', async () => {
  const fixtures = await Promise.all(Array.from({ length: 9 }, (_, index) => noise(index + 1)));
  const output = await composer.composeComparisonImage({
    originals: Array.from({ length: 8 }, (_, index) => ({ name: `Detailed original ${index + 1}`, image: String(index) })),
    replacement: { name: 'Detailed replacement', image: '8' },
  }, { loadImage: async url => fixtures[Number(url)] });
  assert.ok(output.length <= 1_000_000, `The attachment is ${output.length} bytes; the limit is 1,000,000`);
  const image = await decoded(output);
  assert.ok(image.width >= 800 && image.height >= 3280, 'All rows and their full-size labels must remain readable');
  let firstGlyphY = 365;
  let lastGlyphY = 331;
  for (let y = 332; y < 365; y++) {
    for (let x = 32; x < 360; x++) {
      if (pixel(image, x, y).every(channel => channel > 140)) {
        firstGlyphY = Math.min(firstGlyphY, y);
        lastGlyphY = Math.max(lastGlyphY, y);
      }
    }
  }
  assert.ok(lastGlyphY - firstGlyphY + 1 >= 18, 'The original name must retain a readable glyph height, including after compression');
});

// Catches accepting a comparison with no original and returning a blank/invalid attachment.
test('rejects a comparison with no original using an actionable contract error', async () => {
  await assert.rejects(composer.composeComparisonImage({ originals: [], replacement: { name: 'Replacement' } }), /at least one original/i);
});

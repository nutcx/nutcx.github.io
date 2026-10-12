import sharp from 'sharp';

const WIDTH = 1000;
const ROW_HEIGHT = 410;
const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 250;
const LEFT = 32;
const RIGHT = 548;
const IMAGE_TOP = 60;
const BACKGROUND = '#101725';
const PANEL_BACKGROUND = '#1d293b';
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 8_000_000;
const RASTER_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'heif', 'avif']);
const MAX_ATTACHMENT_BYTES = 1_000_000;
const NAME_TOP = 332;
const NAME_HEIGHT = 58;
const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function rowLabels() {
  return Buffer.from(`<svg width="${WIDTH}" height="${ROW_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <g font-family="DejaVu Sans, sans-serif" fill="#f2f5fa">
      <text x="${LEFT}" y="38" font-size="24" font-weight="bold">Original</text>
      <text x="${RIGHT}" y="38" font-size="24" font-weight="bold">Replacement</text>
    </g>
    <path d="M 474 185 H 524 M 510 171 L 524 185 L 510 199" stroke="#98accb" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`);
}

async function namePanel(value, fallback) {
  const text = String(value ?? '').slice(0, 1024).toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/gu, '').replace(/\s+/gu, ' ').trim() || fallback;
  const render = label => sharp({ text: {
    text: `<span foreground="#f2f5fa">${escapeXml(label)}</span>`,
    font: 'DejaVu Sans 22', width: PANEL_WIDTH, rgba: true, dpi: 72, spacing: 5, wrap: 'word-char',
  } });
  let label = text;
  if ((await render(label).metadata()).height > NAME_HEIGHT) {
    const graphemes = Array.from(graphemeSegmenter.segment(text), part => part.segment);
    let start = 0;
    let end = graphemes.length;
    label = '…';
    while (start <= end) {
      const length = Math.floor((start + end) / 2);
      const candidate = `${graphemes.slice(0, length).join('').trimEnd()}…`;
      if ((await render(candidate).metadata()).height <= NAME_HEIGHT) {
        label = candidate;
        start = length + 1;
      } else {
        end = length - 1;
      }
    }
  }
  return render(label).png().toBuffer();
}

async function panel(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_INPUT_BYTES) throw new Error('Unavailable raster input');
  const image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true, failOn: 'warning', animated: false });
  const metadata = await image.metadata();
  if (!RASTER_FORMATS.has(metadata.format) || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw new Error('Unavailable raster dimensions');
  }
  return image.rotate().resize(PANEL_WIDTH, PANEL_HEIGHT, { fit: 'contain', background: PANEL_BACKGROUND }).png().toBuffer();
}

function unavailablePanel() {
  return Buffer.from(`<svg width="${PANEL_WIDTH}" height="${PANEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${PANEL_BACKGROUND}"/><text x="210" y="134" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="24" fill="#f2f5fa">Preview unavailable</text></svg>`);
}

async function loadPanel(url, loadImage) {
  try {
    return await panel(url ? await loadImage(url) : null);
  } catch {
    return unavailablePanel();
  }
}

/**
 * Return a WebP Buffer with ordered Original → Replacement rows.
 * `loadImage(url)` supplies a raster Buffer or null; the default performs no I/O.
 * Only eight originals are loaded/shown. Inputs are capped at 8 MiB / 8M pixels,
 * labels remain 22px, and the attachment is at most 1,000,000 bytes.
 */
export async function composeComparisonImage({ originals, replacement }, { loadImage = async () => null } = {}) {
  if (!Array.isArray(originals) || originals.length === 0) throw new TypeError('Comparison requires at least one original');
  const shown = originals.slice(0, 8);
  const remaining = originals.length - shown.length;
  const height = shown.length * ROW_HEIGHT + (remaining > 0 ? 70 : 0);
  const right = await loadPanel(replacement.image, loadImage);
  const rightName = await namePanel(replacement.name, 'Unnamed replacement');
  const layers = [];
  for (const [index, original] of shown.entries()) {
    const rowTop = index * ROW_HEIGHT;
    layers.push(
      { input: await loadPanel(original.image, loadImage), left: LEFT, top: rowTop + IMAGE_TOP },
      { input: right, left: RIGHT, top: rowTop + IMAGE_TOP },
      { input: rowLabels(), left: 0, top: rowTop },
      { input: await namePanel(original.name, 'Unnamed original'), left: LEFT, top: rowTop + NAME_TOP },
      { input: rightName, left: RIGHT, top: rowTop + NAME_TOP },
    );
  }
  if (remaining > 0) {
    layers.push({ input: Buffer.from(`<svg width="${WIDTH}" height="70" xmlns="http://www.w3.org/2000/svg"><text x="500" y="42" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="24" fill="#f2f5fa">${remaining} more originals — see website</text></svg>`), left: 0, top: shown.length * ROW_HEIGHT });
  }
  const image = sharp({ create: { width: WIDTH, height, channels: 3, background: BACKGROUND } }).composite(layers);
  for (const quality of [80, 65, 50, 35, 20, 10, 1]) {
    const output = await image.clone().webp({ quality }).toBuffer();
    if (output.length <= MAX_ATTACHMENT_BYTES) return output;
  }
  throw new Error('Comparison attachment exceeds the one-megabyte limit');
}

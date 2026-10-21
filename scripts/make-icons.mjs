// Renders the CheckLater icon (same shape as web/public/icons/icon.svg) to PNGs.
// No dependencies: a tiny anti-aliased rasterizer + PNG encoder.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BRAND = [0x5b, 0x5b, 0xd6];
const WHITE = [255, 255, 255];

// Shapes in a 0..100 coordinate space.
const inRoundRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 100 - r);
  const cy = Math.min(Math.max(y, r), 100 - r);
  return x >= 0 && x <= 100 && y >= 0 && y <= 100 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inBookmark = (x, y) =>
  x >= 32 && x <= 68 && y >= 22 && y <= 80 && y <= 64 + (16 * Math.abs(x - 50)) / 18;
const distToSeg = (px, py, [ax, ay], [bx, by]) => {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
};
const inCheck = (x, y) => Math.min(distToSeg(x, y, [40, 43], [47, 50]), distToSeg(x, y, [47, 50], [60, 36])) <= 3.5;

// Returns [r,g,b,a] for a point. `maskable` = full-bleed background, content shrunk into the safe zone.
function sample(x, y, maskable) {
  if (maskable) {
    const s = 0.72; // keep content inside the 80% safe circle
    const ux = 50 + (x - 50) / s;
    const uy = 50 + (y - 50) / s;
    if (inBookmark(ux, uy)) return inCheck(ux, uy) ? [...BRAND, 255] : [...WHITE, 255];
    return [...BRAND, 255];
  }
  if (!inRoundRect(x, y, 22)) return [0, 0, 0, 0];
  if (inBookmark(x, y)) return inCheck(x, y) ? [...BRAND, 255] : [...WHITE, 255];
  return [...BRAND, 255];
}

function render(size, maskable = false) {
  const SS = 4; // 4x4 supersampling
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = sample(((i + (sx + 0.5) / SS) / size) * 100, ((j + (sy + 0.5) / SS) / size) * 100, maskable);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const o = (j * size + i) * 4;
      px[o] = a ? r / a : 0;
      px[o + 1] = a ? g / a : 0;
      px[o + 2] = a ? b / a : 0;
      px[o + 3] = a / (SS * SS);
    }
  }
  return encodePng(size, px);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = [
  ['web/public/icons/icon-192.png', 192],
  ['web/public/icons/icon-512.png', 512],
  ['web/public/icons/maskable-512.png', 512, true],
  ['extension/icons/icon16.png', 16],
  ['extension/icons/icon32.png', 32],
  ['extension/icons/icon48.png', 48],
  ['extension/icons/icon128.png', 128],
];
mkdirSync('web/public/icons', { recursive: true });
mkdirSync('extension/icons', { recursive: true });
for (const [file, size, maskable] of out) {
  writeFileSync(file, render(size, maskable));
  console.log('wrote', file);
}

'use strict';

/**
 * The Voxara mark, drawn as raw RGBA and PNG-encoded from scratch — no image
 * library needed for something this simple, and it means the exact same
 * drawing code can bake app-icon PNGs at build time (see build/after-pack.js)
 * and render the live tray icon at runtime (see main.js), instead of shipping
 * two versions that can drift apart.
 *
 * The shape: five bars tracing a shallow voice-waveform valley — the same
 * silhouette as the in-app speaking indicator, framed as a mark. Deliberately
 * not the old Pulse heartbeat-line shape.
 */

/** RGBA raw buffer -> PNG file bytes. Square images only (all our icon sizes are). */
function rgbaToPng(size, raw) {
  const zlib = require('node:zlib');
  const crcTable = rgbaToPng._crc || (rgbaToPng._crc = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  const crc32 = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Bars as fractions of the 112-unit viewBox the design was drawn at, so they
// scale cleanly to any output size. [xFrac, yFrac, wFrac, hFrac, opacity]
// x/y are relative to tile centre; y is the bar's top edge (bars grow down
// from the vertical middle by half their own height on each side).
const BARS = [
  { x: -38, halfH: 10, w: 11, opacity: 1 },
  { x: -21, halfH: 19, w: 11, opacity: 1 },
  { x: -4, halfH: 27, w: 11, opacity: 0.4 },
  { x: 13, halfH: 19, w: 11, opacity: 1 },
  { x: 30, halfH: 10, w: 11, opacity: 1 },
];
const VIEWBOX = 112;
const BAR_RADIUS_FRAC = 2.5 / VIEWBOX;
const TILE_RADIUS_FRAC = 24 / 112;

function mix(bg, fg, t) {
  return [
    Math.round(bg[0] + (fg[0] - bg[0]) * t),
    Math.round(bg[1] + (fg[1] - bg[1]) * t),
    Math.round(bg[2] + (fg[2] - bg[2]) * t),
  ];
}

function roundedRectHit(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  if (dx <= 0 || dy <= 0) return Math.abs(px - cx) <= halfW && Math.abs(py - cy) <= halfH;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * The mark on its rounded-square tile, as a raw RGBA buffer.
 * `bg`/`fg` are [r,g,b] — defaults match the app's own dark tokens.
 */
function drawMarkRGBA(size, { bg = [18, 18, 21], fg = [77, 124, 254] } = {}) {
  // +1 per row: PNG scanlines need a leading filter-type byte (0 = "None"),
  // left as the zero Buffer.alloc default — rgbaToPng deflates this as-is.
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const tileRadius = size * TILE_RADIUS_FRAC;
  const barRadius = Math.max(0.6, size * BAR_RADIUS_FRAC);
  const scale = size / VIEWBOX;
  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = y * stride + 1 + x * 4;
      const inTile = roundedRectHit(x, y, cx, cy, size / 2, size / 2, tileRadius);
      let color = bg;
      if (inTile) {
        for (const bar of BARS) {
          const barCx = cx + bar.x * scale + (bar.w * scale) / 2;
          const barHalfW = (bar.w * scale) / 2;
          const barHalfH = bar.halfH * scale;
          if (roundedRectHit(x, y, barCx, cy, barHalfW, barHalfH, barRadius)) {
            color = bar.opacity >= 1 ? fg : mix(bg, fg, bar.opacity);
            break;
          }
        }
      }
      raw[o] = color[0]; raw[o + 1] = color[1]; raw[o + 2] = color[2];
      raw[o + 3] = inTile ? 255 : 0;
    }
  }
  return raw;
}

function markIconPng(size, options) {
  return rgbaToPng(size, drawMarkRGBA(size, options));
}

module.exports = { rgbaToPng, drawMarkRGBA, markIconPng };

/**
 * A small QR code encoder (ISO 18004): byte mode, error-correction level M,
 * versions 1 to 10 (up to 213 bytes of data, plenty for an otpauth:// URL).
 * Pure functions plus one helper that draws the result as an inline SVG, so
 * the authenticator-app setup screen never sends a secret to a third party
 * to have a picture made of it.
 */

// Per version (index 1..10), level M: [total codewords, ec codewords per
// block, [blocks, data codewords per block] ...]
const VERSIONS = [null,
  [26, 10, [1, 16]],
  [44, 16, [1, 28]],
  [70, 26, [1, 44]],
  [100, 18, [2, 32]],
  [134, 24, [2, 43]],
  [172, 16, [4, 27]],
  [196, 18, [4, 31]],
  [242, 22, [2, 38], [2, 39]],
  [292, 22, [3, 36], [2, 37]],
  [346, 26, [4, 43], [1, 44]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// ------------------------------------------------------------- GF(256)
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generatorPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecCodewords(data, n) {
  const gen = generatorPoly(n);
  const out = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.shift(); out.push(0);
    if (factor === 0) continue;
    for (let j = 0; j < n; j += 1) out[j] ^= mul(gen[j + 1], factor);
  }
  return out;
}

// ------------------------------------------------------------- bits
function encodeData(bytes, version) {
  const [total, ecPerBlock, ...groups] = VERSIONS[version];
  const dataCodewords = total - ecPerBlock * groups.reduce((s, [count]) => s + count, 0);
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCodewords * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; words.length < dataCodewords; pad ^= 0xec ^ 0x11) words.push(pad);

  // Split into blocks, compute EC for each, then interleave.
  const blocks = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i += 1) {
      const data = words.slice(offset, offset + size);
      offset += size;
      blocks.push({ data, ec: ecCodewords(data, ecPerBlock) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i += 1) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecPerBlock; i += 1) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ------------------------------------------------------------- matrix
function makeMatrix(version, codewords) {
  const size = version * 4 + 17;
  const grid = Array.from({ length: size }, () => new Int8Array(size).fill(-1)); // -1 = free
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));
  const set = (r, c, v) => { grid[r][c] = v; reserved[r][c] = 1; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) {
      const rr = r0 + r; const cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const edge = r === -1 || r === 7 || c === -1 || c === 7;
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(rr, cc, edge ? 0 : (ring || core ? 1 : 0));
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }

  const centers = ALIGN[version];
  for (const r0 of centers) for (const c0 of centers) {
    // The three that would sit on a finder are omitted; ones crossing the
    // timing pattern are kept (their modules agree with it).
    const onFinder = (r0 < 9 && c0 < 9) || (r0 < 9 && c0 > size - 10) || (r0 > size - 10 && c0 < 9);
    if (onFinder) continue;
    for (let r = -2; r <= 2; r += 1) for (let c = -2; c <= 2; c += 1) {
      const ring = Math.max(Math.abs(r), Math.abs(c));
      set(r0 + r, c0 + c, ring === 1 ? 0 : 1);
    }
  }

  set(size - 8, 8, 1); // the dark module

  // Reserve format areas (filled in later) and version areas.
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) { reserved[8][i] = 1; reserved[i][8] = 1; }
    if (i < 8) { reserved[8][size - 1 - i] = 1; reserved[size - 1 - i][8] = 1; }
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) for (let j = 0; j < 3; j += 1) { reserved[i][size - 11 + j] = 1; reserved[size - 11 + j][i] = 1; }
  }

  // Data placement: two-column zigzag from the bottom right, skipping column 6.
  const bits = [];
  for (const w of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((w >> i) & 1);
  let bit = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let k = 0; k < size; k += 1) {
      const row = upward ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        grid[row][c] = bits[bit] || 0;
        bit += 1;
      }
    }
    upward = !upward;
  }
  return { size, grid, reserved };
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function bch(value, poly, bitsLen, polyLen) {
  let v = value << (polyLen - 1);
  for (let i = bitsLen + polyLen - 2; i >= polyLen - 1; i -= 1) if ((v >> i) & 1) v ^= poly << (i - (polyLen - 1));
  return v;
}

function applyMaskAndFormat({ size, grid, reserved }, mask) {
  const out = grid.map((row) => Int8Array.from(row));
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) {
    if (!reserved[r][c] && MASKS[mask](r, c)) out[r][c] ^= 1;
  }
  // Format info: EC level M (00) + mask, BCH(15,5), XOR 0x5412.
  const data = (0b00 << 3) | mask;
  const format = ((data << 10) | bch(data, 0b10100110111, 5, 11)) ^ 0x5412;
  const fbit = (i) => (format >> i) & 1;
  for (let i = 0; i < 6; i += 1) { out[8][i] = fbit(14 - i); out[i][8] = fbit(i); }
  out[8][7] = fbit(8); out[8][8] = fbit(7); out[7][8] = fbit(6);
  for (let i = 0; i < 8; i += 1) out[size - 1 - i][8] = fbit(14 - i);
  for (let i = 0; i < 8; i += 1) out[8][size - 8 + i] = fbit(7 - i);
  out[size - 8][8] = 1;
  return out;
}

function applyVersionInfo(matrix, size, version) {
  if (version < 7) return;
  const info = (version << 12) | bch(version, 0b1111100100101, 6, 13);
  for (let i = 0; i < 18; i += 1) {
    const bit = (info >> i) & 1;
    const a = Math.floor(i / 3); const b = size - 11 + (i % 3);
    matrix[a][b] = bit; matrix[b][a] = bit;
  }
}

function penalty(m, size) {
  let score = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < size; i += 1) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        const a = pass ? m[j][i] : m[i][j];
        const b = pass ? m[j - 1][i] : m[i][j - 1];
        if (a === b) { run += 1; if (run === 5) score += 3; else if (run > 5) score += 1; } else run = 1;
      }
    }
  }
  for (let r = 0; r < size - 1; r += 1) for (let c = 0; c < size - 1; c += 1) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  const check = (get) => {
    for (let i = 0; i < size; i += 1) for (let j = 0; j <= size - 11; j += 1) {
      let ok1 = true; let ok2 = true;
      for (let k = 0; k < 7; k += 1) {
        if (get(i, j + k) !== pattern[k]) ok1 = false;
        if (get(i, j + 4 + k) !== pattern[k]) ok2 = false;
      }
      if (ok1 && [0, 1, 2, 3].every((k) => get(i, j + 7 + k) === 0)) score += 40;
      if (ok2 && [0, 1, 2, 3].every((k) => get(i, j + k) === 0)) score += 40;
    }
  };
  check((i, j) => m[i][j]); check((i, j) => m[j][i]);
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/** Encodes `text` (UTF-8) and returns { size, modules: Int8Array[][] }. */
export function encodeQr(text) {
  const bytes = new TextEncoder().encode(String(text));
  let version = 0;
  for (let v = 1; v <= 10; v += 1) {
    const [total, ec, ...groups] = VERSIONS[v];
    const capacity = total - ec * groups.reduce((s, [count]) => s + count, 0) - (v >= 10 ? 3 : 2);
    if (bytes.length <= capacity) { version = v; break; }
  }
  if (!version) throw new Error('Too much data for a QR code here.');
  const codewords = encodeData(bytes, version);
  const base = makeMatrix(version, codewords);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMaskAndFormat(base, mask);
    applyVersionInfo(candidate, base.size, version);
    const score = penalty(candidate, base.size);
    if (!best || score < best.score) best = { score, modules: candidate };
  }
  return { size: base.size, modules: best.modules };
}

/** An inline SVG of the code, `px` wide, with a quiet zone, dark on light. */
export function qrSvg(text, px = 200) {
  const { size, modules } = encodeQr(text);
  const quiet = 4;
  const total = size + quiet * 2;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('width', String(px));
  svg.setAttribute('height', String(px));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(total)); bg.setAttribute('height', String(total)); bg.setAttribute('fill', '#ffffff');
  svg.appendChild(bg);
  let d = '';
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) {
    if (modules[r][c] === 1) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d); path.setAttribute('fill', '#000000');
  svg.appendChild(path);
  return svg;
}

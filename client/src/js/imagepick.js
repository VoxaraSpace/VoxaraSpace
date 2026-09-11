/**
 * Picks an image file and downscales it to a JPEG data URL entirely in the
 * renderer, so the server only ever receives a small, known-format image.
 */

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

export const AVATAR_SPEC = { width: 256, height: 256, quality: 0.86 };
export const BANNER_SPEC = { width: 960, height: 360, quality: 0.82 };

/** Opens the OS file picker. Resolves null if the user cancels. */
export function chooseImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('change', () => finish(input.files?.[0] || null));
    // There is no reliable "cancelled" event; clean up when focus returns.
    window.addEventListener('focus', () => setTimeout(() => finish(input.files?.[0] || null), 400), { once: true });
    input.click();
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image.'));
    };
    img.src = url;
  });
}

/**
 * Centre-crops to the target aspect ratio, scales down, and encodes JPEG.
 * `background` fills behind transparent pixels, which JPEG cannot represent.
 */
export async function fileToJpegDataUrl(file, spec, background = '#1c1c20') {
  if (!file) return null;
  if (!file.type.startsWith('image/')) {
    throw new Error('Pick an image file (PNG, JPEG, WebP or GIF).');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('That image is larger than 12 MB. Try a smaller one.');
  }

  const img = await loadImage(file);
  const targetRatio = spec.width / spec.height;
  const sourceRatio = img.width / img.height;

  let sx = 0;
  let sy = 0;
  let sw = img.width;
  let sh = img.height;
  if (sourceRatio > targetRatio) {
    sw = img.height * targetRatio;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / targetRatio;
    sy = (img.height - sh) / 2;
  }

  // Never upscale past the source resolution.
  const scale = Math.min(1, spec.width / sw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  let quality = spec.quality;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  // The server caps uploads at 400 KB; step the quality down if we are over.
  while (dataUrl.length * 0.75 > 380 * 1024 && quality > 0.4) {
    quality -= 0.12;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  return dataUrl;
}

/**
 * Downscale an image to fit `size`×`size` and encode as PNG, preserving
 * transparency — used for custom emoji. Steps the dimensions down if the PNG
 * comes out over `maxBytes`.
 */
export async function fileToPngDataUrl(file, size = 128, maxBytes = 256 * 1024) {
  if (!file) return null;
  if (!file.type.startsWith('image/')) throw new Error('Pick an image file (PNG, GIF, WebP or JPEG).');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('That image is larger than 12 MB. Try a smaller one.');

  const img = await loadImage(file);
  let dim = size;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const scale = Math.min(1, dim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/png');
    if (dataUrl.length * 0.75 <= maxBytes) return dataUrl;
    dim = Math.round(dim * 0.75);
  }
  throw new Error('That image is too detailed for an emoji — try a simpler one.');
}

/** Read a file straight to a data URL (no re-encode), rejecting oversized ones. */
export function fileToRawDataUrl(file, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file.'));
    if (file.size > maxBytes) return reject(new Error(`That file is over ${Math.round(maxBytes / 1024)} KB.`));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

// --------------------------------------------------------------- attachments

// One ceiling for everyone — matches server/src/gateway.js MAX_ATTACHMENT_BYTES.
export const MAX_ATTACHMENT_BYTES = 525 * 1024 * 1024;

/** Opens the file picker for message attachments (any type, multi-select). */
export function chooseFiles() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('change', () => finish([...(input.files || [])]));
    window.addEventListener('focus', () => setTimeout(() => finish([...(input.files || [])]), 400), { once: true });
    input.click();
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/** Natural pixel size of an image file, so the message list can reserve space. */
function imageSize(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: null, height: null });
    };
    img.src = url;
  });
}

/**
 * Prepares a file for upload. Images keep their original bytes so GIFs stay
 * animated; only an oversized still image is re-encoded down to fit.
 */
export async function prepareAttachment(file) {
  const isImage = file.type.startsWith('image/');
  const isAnimated = file.type === 'image/gif';

  if (file.size > MAX_ATTACHMENT_BYTES) {
    if (!isImage || isAnimated) {
      throw new Error(`${file.name} is larger than 525 MB.`);
    }
    const dataUrl = await fileToJpegDataUrl(file, { width: 1600, height: 1600, quality: 0.85 }, '#000');
    return { name: file.name.replace(/\.\w+$/, '.jpg'), type: 'image/jpeg', data: dataUrl, width: null, height: null };
  }

  const [dataUrl, size] = await Promise.all([
    readAsDataUrl(file),
    isImage ? imageSize(file) : Promise.resolve({ width: null, height: null }),
  ]);
  return { name: file.name, type: file.type || 'application/octet-stream', data: dataUrl, ...size };
}

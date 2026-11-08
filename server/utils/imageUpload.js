const fs = require('fs');
const path = require('path');

const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/x-png',
  'image/webp'
]);
const GENERIC_MIMES = new Set(['application/octet-stream', 'binary/octet-stream', '']);

function readFileHeader(filePath, length = 12) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function detectImageExtFromBuffer(buf) {
  if (!buf || buf.length < 3) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return '.webp';
  }
  return null;
}

function detectImageExtFromFile(filePath) {
  try {
    return detectImageExtFromBuffer(readFileHeader(filePath));
  } catch {
    return null;
  }
}

function isAllowedImageUploadMeta(originalname, mimetype) {
  const ext = path.extname(originalname || '').toLowerCase();
  const mime = String(mimetype || '').toLowerCase();
  if (ALLOWED_IMAGE_MIMES.has(mime) || ALLOWED_IMAGE_EXTS.has(ext)) return true;
  if (GENERIC_MIMES.has(mime)) return true;
  return false;
}

function ensureUploadedImageExt(file) {
  if (!file?.path || !file?.filename) return { ok: false, error: 'Upload failed' };

  const detectedExt = detectImageExtFromFile(file.path);
  if (!detectedExt) {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return { ok: false, error: 'Only JPEG, PNG and WEBP images are allowed' };
  }

  const currentExt = path.extname(file.filename).toLowerCase();
  if (currentExt !== detectedExt) {
    const baseName = file.filename.replace(/\.[^.]+$/, '') || file.filename;
    const newFilename = `${baseName}${detectedExt}`;
    const newPath = path.join(path.dirname(file.path), newFilename);
    fs.renameSync(file.path, newPath);
    file.filename = newFilename;
    file.path = newPath;
  }

  return { ok: true, ext: detectedExt };
}

module.exports = {
  ALLOWED_IMAGE_EXTS,
  ALLOWED_IMAGE_MIMES,
  detectImageExtFromBuffer,
  detectImageExtFromFile,
  isAllowedImageUploadMeta,
  ensureUploadedImageExt
};

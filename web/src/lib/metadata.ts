// Removes location and other metadata from photos before they leave the device.
// Works on the raw bytes, so image quality is untouched. JPEG orientation is preserved.

const JPEG_STRIP = new Set([0xe1, 0xed]); // APP1 (EXIF/XMP), APP13 (IPTC/Photoshop)
const PNG_STRIP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);

function readOrientation(view: DataView, start: number, end: number): number {
  // APP1 payload: "Exif\0\0" then a TIFF header.
  if (end - start < 14 || view.getUint32(start) !== 0x45786966) return 1;
  const tiff = start + 6;
  const little = view.getUint16(tiff) === 0x4949;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
  }
  return 1;
}

/** A 34-byte APP1 segment that carries nothing but the orientation tag. */
function orientationSegment(orientation: number): Uint8Array {
  const seg = new Uint8Array(36);
  const v = new DataView(seg.buffer);
  v.setUint16(0, 0xffe1);
  v.setUint16(2, 34);
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
  seg.set([0x49, 0x49, 0x2a, 0x00], 10); // little-endian TIFF
  v.setUint32(14, 8, true); // IFD0 offset
  v.setUint16(18, 1, true); // one entry
  v.setUint16(20, 0x0112, true); // Orientation
  v.setUint16(22, 3, true); // SHORT
  v.setUint32(24, 1, true);
  v.setUint16(28, orientation, true);
  v.setUint32(32, 0, true); // no next IFD
  return seg;
}

function stripJpeg(buf: ArrayBuffer): Uint8Array[] | null {
  const view = new DataView(buf);
  if (view.getUint16(0) !== 0xffd8) return null;
  const parts: Uint8Array[] = [new Uint8Array(buf, 0, 2)];
  let orientation = 1;
  let pos = 2;
  while (pos + 4 <= buf.byteLength) {
    if (view.getUint8(pos) !== 0xff) return null;
    const marker = view.getUint8(pos + 1);
    if (marker === 0xda) break; // start of scan: the rest is image data
    const len = view.getUint16(pos + 2);
    const next = pos + 2 + len;
    if (next > buf.byteLength) return null;
    if (JPEG_STRIP.has(marker)) {
      if (marker === 0xe1 && orientation === 1) orientation = readOrientation(view, pos + 4, next);
    } else {
      parts.push(new Uint8Array(buf, pos, next - pos));
    }
    pos = next;
  }
  parts.push(new Uint8Array(buf, pos));
  if (orientation > 1 && orientation <= 8) parts.splice(1, 0, orientationSegment(orientation));
  return parts;
}

function stripPng(buf: ArrayBuffer): Uint8Array[] | null {
  const view = new DataView(buf);
  if (view.getUint32(0) !== 0x89504e47) return null;
  const parts: Uint8Array[] = [new Uint8Array(buf, 0, 8)];
  let pos = 8;
  while (pos + 12 <= buf.byteLength) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...new Uint8Array(buf, pos + 4, 4));
    const next = pos + 12 + len;
    if (next > buf.byteLength) return null;
    if (!PNG_STRIP.has(type)) parts.push(new Uint8Array(buf, pos, next - pos));
    pos = next;
    if (type === 'IEND') break;
  }
  return parts;
}

export async function stripMetadata(file: File): Promise<File> {
  const type = file.type;
  if (type !== 'image/jpeg' && type !== 'image/png') return file;
  try {
    const buf = await file.arrayBuffer();
    const parts = type === 'image/jpeg' ? stripJpeg(buf) : stripPng(buf);
    if (!parts) return file;
    return new File(parts as BlobPart[], file.name, { type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

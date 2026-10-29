// Removes location (and, for photos, other camera metadata) before files leave the device.
// Works on the raw bytes, so image and video quality are untouched.
//
// - JPEG, PNG and WebP: metadata segments are dropped. JPEG orientation is preserved.
// - HEIC/HEIF/AVIF and MP4/MOV address their data by absolute byte offsets, so nothing can be removed
//   without rewriting the file. Location is overwritten in place instead, keeping every byte where it was.
//   For videos only the small metadata box is read; the video stream itself is reused untouched.

const JPEG_STRIP = new Set([0xe1, 0xed]); // APP1 (EXIF/XMP), APP13 (IPTC/Photoshop)
const PNG_STRIP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);
const WEBP_STRIP = new Set(['EXIF', 'XMP ']);
const HEIF_TYPES = new Set(['image/heic', 'image/heif', 'image/avif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/3gpp']);
/** Metadata boxes larger than this are left alone rather than read into memory. */
const MAX_META_BOX = 64 * 1024 * 1024;

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** The orientation tag from a TIFF block (EXIF), or 1. */
function tiffOrientation(v: DataView, tiff: number, end: number): number {
  if (tiff + 8 > end) return 1;
  const little = v.getUint16(tiff) === 0x4949;
  if (!little && v.getUint16(tiff) !== 0x4d4d) return 1;
  const ifd = tiff + v.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = v.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (v.getUint16(entry, little) === 0x0112) return v.getUint16(entry + 8, little);
  }
  return 1;
}

/** A little-endian TIFF block holding only the orientation tag (26 bytes). */
function orientationTiff(orientation: number): Uint8Array {
  const t = new Uint8Array(26);
  const v = view(t);
  t.set([0x49, 0x49, 0x2a, 0x00]);
  v.setUint32(4, 8, true); // IFD0 offset
  v.setUint16(8, 1, true); // one entry
  v.setUint16(10, 0x0112, true); // Orientation
  v.setUint16(12, 3, true); // SHORT
  v.setUint32(14, 1, true);
  v.setUint16(18, orientation, true);
  v.setUint32(22, 0, true); // no next IFD
  return t;
}

// ---- JPEG, PNG, WebP: drop metadata segments ----

function stripJpeg(buf: ArrayBuffer): Uint8Array[] | null {
  const v = new DataView(buf);
  if (v.getUint16(0) !== 0xffd8) return null;
  const parts: Uint8Array[] = [new Uint8Array(buf, 0, 2)];
  let orientation = 1;
  let pos = 2;
  while (pos + 4 <= buf.byteLength) {
    if (v.getUint8(pos) !== 0xff) return null;
    const marker = v.getUint8(pos + 1);
    if (marker === 0xda) break; // start of scan: the rest is image data
    const len = v.getUint16(pos + 2);
    const next = pos + 2 + len;
    if (next > buf.byteLength) return null;
    if (JPEG_STRIP.has(marker)) {
      // APP1 payload: "Exif\0\0" then a TIFF block.
      if (marker === 0xe1 && orientation === 1 && len >= 16 && v.getUint32(pos + 4) === 0x45786966) {
        orientation = tiffOrientation(v, pos + 10, next);
      }
    } else {
      parts.push(new Uint8Array(buf, pos, next - pos));
    }
    pos = next;
  }
  parts.push(new Uint8Array(buf, pos));
  if (orientation > 1 && orientation <= 8) {
    const tiff = orientationTiff(orientation);
    const seg = new Uint8Array(10 + tiff.length);
    view(seg).setUint16(0, 0xffe1);
    view(seg).setUint16(2, 8 + tiff.length);
    seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
    seg.set(tiff, 10);
    parts.splice(1, 0, seg);
  }
  return parts;
}

function stripPng(buf: ArrayBuffer): Uint8Array[] | null {
  const v = new DataView(buf);
  if (v.getUint32(0) !== 0x89504e47) return null;
  const parts: Uint8Array[] = [new Uint8Array(buf, 0, 8)];
  let pos = 8;
  while (pos + 12 <= buf.byteLength) {
    const len = v.getUint32(pos);
    const type = String.fromCharCode(...new Uint8Array(buf, pos + 4, 4));
    const next = pos + 12 + len;
    if (next > buf.byteLength) return null;
    if (!PNG_STRIP.has(type)) parts.push(new Uint8Array(buf, pos, next - pos));
    pos = next;
    if (type === 'IEND') break;
  }
  return parts;
}

function stripWebp(buf: ArrayBuffer): Uint8Array[] | null {
  const b = new Uint8Array(buf);
  if (fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP') return null;
  const v = new DataView(buf);
  const kept: Uint8Array[] = [];
  let pos = 12;
  while (pos + 8 <= b.length) {
    const type = fourcc(b, pos);
    const next = pos + 8 + v.getUint32(pos + 4, true) + (v.getUint32(pos + 4, true) & 1); // chunks are padded to even
    if (next > b.length) return null;
    if (!WEBP_STRIP.has(type)) {
      const chunk = b.slice(pos, next);
      if (type === 'VP8X') chunk[8] &= ~0x0c; // clear the "has EXIF" and "has XMP" flags
      kept.push(chunk);
    }
    pos = next;
  }
  const header = b.slice(0, 12);
  view(header).setUint32(4, 4 + kept.reduce((s, c) => s + c.length, 0), true);
  return [header, ...kept];
}

// ---- ISO base media (HEIF and MP4/MOV) ----

interface Box {
  type: string;
  start: number;
  /** Where the payload starts. */
  body: number;
  end: number;
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  const v = view(b);
  let pos = start;
  while (pos + 8 <= end) {
    let size = v.getUint32(pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(v.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type: fourcc(b, pos + 4), start: pos, body: pos + header, end: pos + size };
    pos += size;
  }
}

const child = (b: Uint8Array, parent: Box, offset: number, type: string) =>
  [...boxes(b, parent.body + offset, parent.end)].find((x) => x.type === type);

/** Turns a box into padding: same size, type "free", contents zeroed. Readers skip it. */
function blank(b: Uint8Array, box: Box) {
  b.set([0x66, 0x72, 0x65, 0x65], box.start + 4);
  b.fill(0, box.body, box.end);
}

// XMP can carry GPS coordinates and place names. They are blanked with spaces so the XML keeps its length.
const XMP_LOCATION = String.raw`(?:exif:GPS\w+|photoshop:(?:City|State|Country)|Iptc4xmpCore:(?:Location|CountryCode)|Iptc4xmpExt:Location\w*)`;
const XMP_ATTR = new RegExp(`(${XMP_LOCATION}\\s*=\\s*)("[^"]*"|'[^']*')`, 'g');
const XMP_ELEM = new RegExp(`(<(${XMP_LOCATION})(?:\\s[^>]*)?>)([\\s\\S]*?)(</\\2>)`, 'g');

function blankXmp(b: Uint8Array, start: number, end: number) {
  let s = '';
  for (let i = start; i < end; i += 8192) s += String.fromCharCode(...b.subarray(i, Math.min(i + 8192, end)));
  const spaces = (n: number) => ' '.repeat(n);
  const out = s
    .replace(XMP_ATTR, (_, name: string, value: string) => name + value[0] + spaces(value.length - 2) + value[0])
    .replace(XMP_ELEM, (_, open: string, _n: string, inner: string, close: string) => open + spaces(inner.length) + close);
  if (out === s) return;
  for (let i = 0; i < out.length; i++) b[start + i] = out.charCodeAt(i);
}

/** Replaces a HEIF Exif item (4-byte offset, then TIFF) with one that keeps only the orientation. */
function blankExifItem(b: Uint8Array, ranges: [number, number][]) {
  const payload = new Uint8Array(ranges.reduce((s, [a, z]) => s + z - a, 0));
  let o = 0;
  for (const [a, z] of ranges) {
    payload.set(b.subarray(a, z), o);
    o += z - a;
  }
  if (payload.length < 4) return;
  const tiff = 4 + view(payload).getUint32(0);
  if (tiff > payload.length) return;
  const orientation = tiffOrientation(view(payload), tiff, payload.length);
  payload.fill(0, tiff);
  const minimal = orientationTiff(orientation > 1 && orientation <= 8 ? orientation : 1);
  if (tiff + minimal.length <= payload.length) payload.set(minimal, tiff);
  o = 0;
  for (const [a, z] of ranges) {
    b.set(payload.subarray(o, o + z - a), a);
    o += z - a;
  }
}

/** HEIC/HEIF/AVIF: finds the Exif and XMP items through the meta box and clears location in place. */
function stripHeif(b: Uint8Array): boolean {
  const top = [...boxes(b, 0, b.length)];
  if (top[0]?.type !== 'ftyp') return false;
  const meta = top.find((x) => x.type === 'meta');
  if (!meta) return true;
  const v = view(b);
  const iinf = child(b, meta, 4, 'iinf');
  const iloc = child(b, meta, 4, 'iloc');
  const idat = child(b, meta, 4, 'idat');
  if (!iinf || !iloc) return true;

  // Item types: "Exif", or "mime" with an XMP content type.
  const kinds = new Map<number, 'exif' | 'xmp'>();
  const iinfV = b[iinf.body];
  for (const infe of boxes(b, iinf.body + (iinfV === 0 ? 6 : 8), iinf.end)) {
    if (infe.type !== 'infe' || b[infe.body] < 2) continue;
    const wide = b[infe.body] >= 3;
    const id = wide ? v.getUint32(infe.body + 4) : v.getUint16(infe.body + 4);
    let p = infe.body + 4 + (wide ? 4 : 2) + 2;
    const type = fourcc(b, p);
    p += 4;
    while (p < infe.end && b[p]) p++; // item name
    if (type === 'Exif') kinds.set(id, 'exif');
    if (type === 'mime') {
      let ct = '';
      for (p++; p < infe.end && b[p]; p++) ct += String.fromCharCode(b[p]);
      if (/xmp|rdf\+xml/i.test(ct)) kinds.set(id, 'xmp');
    }
  }
  if (!kinds.size) return true;

  // Where each of those items' bytes are.
  const ver = b[iloc.body];
  let p = iloc.body + 4;
  const offSize = b[p] >> 4;
  const lenSize = b[p] & 15;
  const baseSize = b[p + 1] >> 4;
  const idxSize = ver === 1 || ver === 2 ? b[p + 1] & 15 : 0;
  p += 2;
  const read = (n: number) => {
    const val = n === 0 ? 0 : n === 4 ? v.getUint32(p) : n === 8 ? Number(v.getBigUint64(p)) : n === 2 ? v.getUint16(p) : NaN;
    p += n;
    return val;
  };
  const count = ver < 2 ? read(2) : read(4);
  for (let i = 0; i < count && p < iloc.end; i++) {
    const id = ver < 2 ? read(2) : read(4);
    const method = ver === 1 || ver === 2 ? read(2) & 15 : 0;
    read(2); // data reference index
    const base = read(baseSize);
    const extents = read(2);
    const ranges: [number, number][] = [];
    for (let e = 0; e < extents; e++) {
      read(idxSize);
      const off = read(offSize);
      const len = read(lenSize);
      const origin = method === 0 ? 0 : method === 1 && idat ? idat.body : NaN;
      const a = origin + base + off;
      const z = len === 0 && method === 0 ? b.length : a + len;
      if (Number.isFinite(a) && a >= 0 && z <= b.length && a <= z) ranges.push([a, z]);
    }
    const kind = kinds.get(id);
    if (!kind || !ranges.length || ranges.length !== extents) continue;
    if (kind === 'exif') blankExifItem(b, ranges);
    else for (const [a, z] of ranges) blankXmp(b, a, z);
  }
  return true;
}

const XYZ = '©xyz';
const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';

/**
 * Clears location inside a movie's top-level moov, meta or XMP uuid box, in place:
 * udta "©xyz" and 3GPP "loci" boxes, Apple "com.apple.quicktime.location.*" metadata, and XMP GPS fields.
 */
function stripMovieBox(b: Uint8Array, box: Box) {
  const v = view(b);
  const walk = (start: number, end: number) => {
    for (const x of boxes(b, start, end)) {
      if (x.type === XYZ || x.type === 'loci') blank(b, x);
      else if (x.type === 'XMP_') blankXmp(b, x.body, x.end);
      else if (x.type === 'moov' || x.type === 'trak' || x.type === 'udta') walk(x.body, x.end);
      else if (x.type === 'meta') {
        // QuickTime's meta has no version/flags; MP4's does. Either way "hdlr" comes first.
        const at = fourcc(b, x.body + 4) === 'hdlr' ? x.body : x.body + 4;
        const inner = [...boxes(b, at, x.end)];
        const keys = inner.find((k) => k.type === 'keys');
        const located = new Set<number>();
        if (keys) {
          let p = keys.body + 8;
          for (let i = 1; p + 8 <= keys.end; i++) {
            const size = v.getUint32(p);
            if (size < 8) break;
            let name = '';
            for (let c = p + 8; c < Math.min(p + size, keys.end); c++) name += String.fromCharCode(b[c]);
            if (/location/i.test(name)) located.add(i);
            p += size;
          }
        }
        for (const ilst of inner.filter((k) => k.type === 'ilst')) {
          for (const item of boxes(b, ilst.body, ilst.end)) {
            if (item.type !== XYZ && !located.has(v.getUint32(item.start + 4))) continue;
            for (const data of boxes(b, item.body, item.end)) if (data.type === 'data') b.fill(0, data.body + 8, data.end);
          }
        }
        walk(at, x.end);
      } else if (x.type === 'uuid' && x.end - x.body > 16) {
        const id = [...b.subarray(x.body, x.body + 16)].map((n) => n.toString(16).padStart(2, '0')).join('');
        if (id === XMP_UUID) blankXmp(b, x.body + 16, x.end);
      }
    }
  };
  walk(box.start, box.end);
}

/** MP4/MOV: reads only the top-level box headers and the metadata boxes, and reuses the rest of the file. */
async function stripMovie(file: File): Promise<Blob | null> {
  const parts: Blob[] = [];
  let copied = 0;
  let pos = 0;
  let first = true;
  while (pos + 8 <= file.size) {
    const head = new Uint8Array(await file.slice(pos, pos + 16).arrayBuffer());
    let size = view(head).getUint32(0);
    if (size === 1 && head.length >= 16) size = Number(view(head).getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    const type = fourcc(head, 4);
    if (first && !['ftyp', 'wide', 'free', 'skip', 'moov', 'mdat'].includes(type)) return null;
    first = false;
    if (size < 8 || pos + size > file.size) break;
    if ((type === 'moov' || type === 'meta' || type === 'uuid') && size <= MAX_META_BOX) {
      const box = new Uint8Array(await file.slice(pos, pos + size).arrayBuffer());
      const [root] = boxes(box, 0, box.length);
      if (root) {
        stripMovieBox(box, root);
        parts.push(file.slice(copied, pos), new Blob([box]));
        copied = pos + size;
      }
    }
    pos += size;
  }
  parts.push(file.slice(copied));
  return new Blob(parts);
}

export async function stripMetadata(file: File, mime = file.type): Promise<File> {
  const type = mime.toLowerCase();
  const out = (parts: BlobPart[]) => new File(parts, file.name, { type, lastModified: file.lastModified });
  try {
    if (VIDEO_TYPES.has(type)) {
      const blob = await stripMovie(file);
      return blob ? out([blob]) : file;
    }
    if (HEIF_TYPES.has(type)) {
      const b = new Uint8Array(await file.arrayBuffer());
      return stripHeif(b) ? out([b]) : file;
    }
    const strip = type === 'image/jpeg' ? stripJpeg : type === 'image/png' ? stripPng : type === 'image/webp' ? stripWebp : null;
    if (!strip) return file;
    const parts = strip(await file.arrayBuffer());
    return parts ? out(parts as BlobPart[]) : file;
  } catch {
    return file;
  }
}

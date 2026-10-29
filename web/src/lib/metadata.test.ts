import { describe, expect, test } from 'vitest';
import { stripMetadata } from './metadata';

const enc = new TextEncoder();
const bytes = (...parts: (Uint8Array | number[] | string)[]) => {
  const arrs = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const u16 = (n: number) => [n >> 8, n & 255];
const u32 = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
/** An ISO-BMFF box. */
const box = (type: string, ...payload: (Uint8Array | number[] | string)[]) => {
  const body = bytes(...payload);
  return bytes(u32(8 + body.length), [...type].map((c) => c.charCodeAt(0)), body);
};
const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

async function strip(data: Uint8Array, type: string, name = 'f') {
  const out = await stripMetadata(new File([data as BlobPart], name, { type }));
  return new Uint8Array(await out.arrayBuffer());
}

/** A big-endian TIFF block: IFD0 with Orientation and a GPS pointer, then a GPS IFD with a latitude. */
function tiffWithGps(orientation: number) {
  // header(8) + IFD0: count(2) + 2 entries(24) + next(4) = 38; GPS IFD at 38: count(2) + 1 entry(12) + next(4) = 56; latitude at 56
  return bytes(
    'MM', u16(42), u32(8),
    u16(2), u16(0x0112), u16(3), u32(1), u16(orientation), u16(0), u16(0x8825), u16(4), u32(1), u32(38), u32(0),
    u16(1), u16(0x0002), u16(5), u32(3), u32(56), u32(0),
    u32(51), u32(1), u32(30), u32(1), u32(2700), u32(100), // 51° 30' 27.00"
    'LAT51N-SECRET',
  );
}

const XMP = `<x:xmpmeta><rdf:RDF><rdf:Description exif:GPSLatitude="51,30.45N" exif:GPSLongitude='0,7.6W' photoshop:City="London" xmp:CreatorTool="Camera"><exif:GPSAltitude>12/1</exif:GPSAltitude><Iptc4xmpCore:Location>Hyde Park</Iptc4xmpCore:Location></rdf:Description></rdf:RDF></x:xmpmeta>`;

function expectNoLocation(out: Uint8Array) {
  const s = latin1(out);
  for (const secret of ['LAT51N-SECRET', '51,30.45N', '0,7.6W', 'London', 'Hyde Park', '12/1', '+51.5074-000.1278', 'Manchester']) {
    expect(s, secret).not.toContain(secret);
  }
}

describe('JPEG', () => {
  const seg = (m: number, data: Uint8Array) => bytes([0xff, m], u16(data.length + 2), data);
  const scan = bytes([0xff, 0xda], u16(8), [1, 1, 0, 0, 63, 0], [0x12, 0x34, 0xff, 0xd9]);
  const jpeg = (orientation: number) =>
    bytes([0xff, 0xd8], seg(0xe0, bytes('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0])), seg(0xe1, bytes('Exif\0\0', tiffWithGps(orientation))), seg(0xe1, enc.encode(`http://ns.adobe.com/xap/1.0/\0${XMP}`)), scan);

  test('drops EXIF and XMP but keeps orientation and the image', async () => {
    const out = await strip(jpeg(6), 'image/jpeg');
    expectNoLocation(out);
    const s = latin1(out);
    expect(s).toContain('JFIF');
    expect(latin1(out.slice(-scan.length))).toBe(latin1(scan));
    const tiff = s.indexOf('Exif\0\0') + 6;
    expect(new DataView(out.buffer).getUint16(tiff + 10, true)).toBe(0x0112);
    expect(new DataView(out.buffer).getUint16(tiff + 18, true)).toBe(6);
  });

  test('upright photos get no EXIF at all', async () => {
    expect(latin1(await strip(jpeg(1), 'image/jpeg'))).not.toContain('Exif');
  });
});

test('PNG drops text and EXIF chunks', async () => {
  const chunk = (type: string, data: string) => bytes(u32(data.length), type, data, [0, 0, 0, 0]);
  const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk('IHDR', 'xxxxxxxxxxxxx'), chunk('tEXt', 'GPS\0London'), chunk('iTXt', XMP), chunk('IDAT', 'pixels'), chunk('IEND', ''));
  const out = await strip(png, 'image/png');
  expectNoLocation(out);
  expect(latin1(out)).toContain('pixels');
});

test('WebP drops EXIF and XMP chunks and fixes the header', async () => {
  const chunk = (type: string, data: Uint8Array) => bytes(type, le32(data.length), data, data.length % 2 ? [0] : []);
  const vp8x = chunk('VP8X', bytes([0x0c | 0x10, 0, 0, 0], [0, 0, 0, 0, 0, 0]));
  const body = bytes('WEBP', vp8x, chunk('VP8 ', enc.encode('frame')), chunk('EXIF', tiffWithGps(1)), chunk('XMP ', enc.encode(XMP)));
  const out = await strip(bytes('RIFF', le32(body.length), body), 'image/webp');
  expectNoLocation(out);
  const v = new DataView(out.buffer);
  expect(v.getUint32(4, true)).toBe(out.length - 8);
  expect(out[20] & 0x0c).toBe(0); // EXIF and XMP flags cleared
  expect(out[20] & 0x10).toBe(0x10); // other flags kept
  expect(latin1(out)).toContain('frame');
});

describe('HEIC', () => {
  /**
   * ftyp, meta (iinf: image, Exif, XMP; iloc pointing into mdat; plus an Exif item stored in idat), mdat.
   * Laid out like an iPhone HEIC: metadata items live in mdat and are found through iloc offsets.
   */
  function heic(orientation: number) {
    const exifItem = bytes(u32(6), 'Exif\0\0', tiffWithGps(orientation));
    const xmpItem = enc.encode(XMP);
    const image = enc.encode('HEVC-IMAGE-DATA');
    const idatExif = bytes(u32(0), tiffWithGps(1));
    const ftyp = box('ftyp', 'heic', u32(0), 'mif1heic');
    const build = (mdatStart: number) => {
      const infe = (id: number, type: string, extra = '') => box('infe', [2, 0, 0, 0], u16(id), u16(0), type, '\0', extra);
      const iinf = box('iinf', [0, 0, 0, 0], u16(4), infe(1, 'hvc1'), infe(2, 'Exif'), infe(3, 'mime', 'application/rdf+xml\0'), infe(4, 'Exif'));
      // iloc v1: offset/length 4 bytes, no base offset, no index
      const entry = (id: number, method: number, off: number, len: number) => bytes(u16(id), u16(method), u16(0), u16(1), u32(off), u32(len));
      const d = mdatStart + 8;
      const iloc = box('iloc', [1, 0, 0, 0], [0x44, 0x00], u16(4),
        entry(1, 0, d, image.length), entry(2, 0, d + image.length, exifItem.length), entry(3, 0, d + image.length + exifItem.length, xmpItem.length), entry(4, 1, 0, idatExif.length));
      return box('meta', [0, 0, 0, 0], box('hdlr', u32(0), u32(0), 'pict', u32(0), u32(0), u32(0), '\0'), iinf, iloc, box('idat', idatExif));
    };
    const metaLen = build(0).length;
    const meta = build(ftyp.length + metaLen);
    return { file: bytes(ftyp, meta, box('mdat', image, exifItem, xmpItem)), image };
  }

  test('clears GPS and XMP location in place, keeping size, orientation and the image', async () => {
    const { file, image } = heic(6);
    const out = await strip(file, 'image/heic');
    expect(out.length).toBe(file.length);
    expectNoLocation(out);
    const s = latin1(out);
    expect(s).toContain(latin1(image));
    expect(s).toContain('xmp:CreatorTool="Camera"');
    // The mdat Exif item now holds a minimal little-endian TIFF with the orientation.
    const tiff = s.indexOf('Exif\0\0', s.indexOf('mdat')) + 6;
    expect(s.slice(tiff, tiff + 2)).toBe('II');
    expect(new DataView(out.buffer).getUint16(tiff + 18, true)).toBe(6);
  });

  test('works when the browser gives no file type', async () => {
    const out = await stripMetadata(new File([heic(1).file], 'IMG_1.HEIC', { type: '' }), 'image/heic');
    expectNoLocation(new Uint8Array(await out.arrayBuffer()));
  });

  test('leaves files that are not HEIF alone', async () => {
    const junk = enc.encode('not a heif file at all, LAT51N-SECRET');
    expect(latin1(await strip(junk, 'image/heic'))).toBe(latin1(junk));
  });
});

describe('MP4 and MOV', () => {
  const xyz = box('©xyz', u16(18), u16(0x15c7), '+51.5074-000.1278/');
  const loci = box('loci', [0, 0, 0, 0], u16(0x15c7), 'Manchester\0', [0], u32(0), u32(0), u32(0), 'Earth\0', '\0');
  const key = (name: string) => bytes(u32(8 + name.length), 'mdta', name);
  const item = (index: number, value: string) => bytes(u32(8 + 16 + value.length), u32(index), box('data', u32(1), u32(0), value));
  const appleMeta = box(
    'meta',
    box('hdlr', u32(0), u32(0), 'mdta', u32(0), u32(0), u32(0), '\0'),
    box('keys', [0, 0, 0, 0], u32(3), key('com.apple.quicktime.location.ISO6709'), key('com.apple.quicktime.make'), key('com.apple.quicktime.location.accuracy.horizontal')),
    box('ilst', item(1, '+51.5074-000.1278+010.000/'), item(2, 'Apple'), item(3, '4.7')),
  );
  const mp4Meta = box('meta', [0, 0, 0, 0], box('hdlr', u32(0), u32(0), 'mdir', u32(0), u32(0), u32(0), '\0'), box('ilst', box('©xyz', box('data', u32(1), u32(0), '+51.5074-000.1278/'))));
  const video = enc.encode('VIDEO-STREAM-'.repeat(50));

  test('clears every location field in place and keeps the rest', async () => {
    const moov = box('moov', box('mvhd', new Uint8Array(100)), box('udta', xyz, box('XMP_', XMP)), appleMeta, box('trak', box('udta', loci)), box('udta', mp4Meta));
    const file = bytes(box('ftyp', 'qt  ', u32(0), 'qt  '), box('wide'), box('mdat', video), moov);
    const out = await strip(file, 'video/quicktime');
    expect(out.length).toBe(file.length);
    expectNoLocation(out);
    const s = latin1(out);
    expect(s).toContain('Apple');
    expect(s).toContain(latin1(video));
    expect(s).not.toContain('4.7'); // location accuracy
    expect(s).toContain('com.apple.quicktime.make');
    expect(s).toContain('free'); // ©xyz and loci became padding
  });

  test('handles moov before mdat and an XMP uuid box', async () => {
    const uuid = box('uuid', [0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac], XMP);
    const file = bytes(box('ftyp', 'isom', u32(0), 'isom'), box('moov', box('udta', xyz)), uuid, box('mdat', video));
    const out = await strip(file, 'video/mp4');
    expect(out.length).toBe(file.length);
    expectNoLocation(out);
    expect(latin1(out)).toContain(latin1(video));
  });

  test('leaves files that are not ISO media alone', async () => {
    const junk = enc.encode('RIFF....AVI +51.5074-000.1278 this is not mp4');
    expect(latin1(await strip(junk, 'video/mp4'))).toBe(latin1(junk));
  });
});

test('other types pass through untouched', async () => {
  const gif = enc.encode('GIF89a...');
  const file = new File([gif], 'a.gif', { type: 'image/gif' });
  expect(await stripMetadata(file)).toBe(file);
});

// The face model behind Find me. The library and its weights (about 13 MB) load the first time a guest uses it,
// from SnapWall's own site; photos are read on the device and never leave it.
import { FaceError, type Descriptor } from './faces';

type FaceApi = typeof import('@vladmandic/face-api');

// The bundled TensorFlow.js has these, but the library's types only list the parts it uses itself.
interface Tf {
  setBackend(name: string): Promise<boolean>;
  ready(): Promise<void>;
  io: { decodeWeights(data: ArrayBuffer, specs: unknown[]): Record<string, unknown> };
}
interface Manifest {
  paths: string[];
  weights: unknown[];
}

let loading: Promise<FaceApi> | null = null;
let received = 0;
/** Everyone waiting on the download, told how far along it is (0 to 1). */
const listeners = new Set<(fraction: number) => void>();
const report = (bytes: number) => {
  received += bytes;
  for (const l of listeners) l(Math.min(1, received / __FACE_MODEL_BYTES__));
};

/** Reads a file as it arrives, counting its bytes towards the progress shown. */
async function download(file: string): Promise<ArrayBuffer> {
  const res = await fetch(__FACE_MODELS__ + file);
  if (!res.ok) throw new Error(`${file}: ${res.status}`);
  if (!res.body) {
    const data = await res.arrayBuffer();
    report(data.byteLength);
    return data;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    report(value.byteLength);
  }
  return new Blob(chunks).arrayBuffer();
}

/**
 * One model's weights. The library could fetch these itself, but then the guest would see no progress through most
 * of the download.
 */
async function weights(model: string) {
  const manifest = JSON.parse(new TextDecoder().decode(await download(`${model}-weights_manifest.json`))) as Manifest[];
  const [group] = manifest;
  return { data: await download(group.paths[0]), specs: group.weights };
}

/** Loads Find me's face model, calling onProgress with how much of the download is done (0 to 1). */
export function loadFaceModel(onProgress?: (fraction: number) => void): Promise<FaceApi> {
  if (onProgress) {
    listeners.add(onProgress);
    onProgress(Math.min(1, received / __FACE_MODEL_BYTES__));
  }
  loading ??= (async () => {
    received = 0;
    // The weights download alongside the library's code instead of after it.
    const files = Promise.all(['ssd_mobilenetv1_model', 'face_landmark_68_model', 'face_recognition_model'].map(weights));
    files.catch(() => undefined); // Seen below; this only stops an early failure counting as unhandled.
    const faceapi = await import('@vladmandic/face-api');
    const tf = faceapi.tf as unknown as Tf;
    // WebGL is far faster; the CPU fallback works everywhere but takes seconds per photo.
    if (!(await tf.setBackend('webgl').catch(() => false))) await tf.setBackend('cpu');
    await tf.ready();
    const [ssd, landmarks, recognition] = await files;
    const map = (w: { data: ArrayBuffer; specs: unknown[] }) => tf.io.decodeWeights(w.data, w.specs) as never;
    faceapi.nets.ssdMobilenetv1.loadFromWeightMap(map(ssd));
    faceapi.nets.faceLandmark68Net.loadFromWeightMap(map(landmarks));
    faceapi.nets.faceRecognitionNet.loadFromWeightMap(map(recognition));
    return faceapi;
  })();
  loading.catch(() => (loading = null));
  if (onProgress) loading.finally(() => listeners.delete(onProgress)).catch(() => undefined);
  return loading;
}

// Large enough for faces at the back of a group photo, small enough to keep each photo quick on a phone.
const MAX_SIDE = 1024;

async function canvasOf(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

async function detect(blob: Blob) {
  const faceapi = await loadFaceModel();
  const canvas = await canvasOf(blob);
  try {
    return await faceapi
      .detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();
  } finally {
    // Frees the pixels at once instead of waiting for garbage collection, which matters on phones.
    canvas.width = canvas.height = 0;
  }
}

/** Every face in a photo. */
export async function facesIn(blob: Blob): Promise<Descriptor[]> {
  return (await detect(blob)).map((f) => f.descriptor);
}

/** The guest's own face: the largest one in their selfie. */
export async function selfieFace(blob: Blob): Promise<Descriptor> {
  const faces = await detect(blob);
  if (!faces.length) throw new FaceError('no_face');
  const area = (f: (typeof faces)[number]) => f.detection.box.width * f.detection.box.height;
  return faces.reduce((a, b) => (area(b) > area(a) ? b : a)).descriptor;
}

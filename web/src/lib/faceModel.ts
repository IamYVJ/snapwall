// The face model behind Find me. The library and its weights (about 13 MB) load the first time a guest uses it,
// from SnapWall's own site; photos are read on the device and never leave it.
import { FaceError, type Descriptor } from './faces';

type FaceApi = typeof import('@vladmandic/face-api');

let loading: Promise<FaceApi> | null = null;

export function loadFaceModel(): Promise<FaceApi> {
  loading ??= (async () => {
    const faceapi = await import('@vladmandic/face-api');
    // The bundled TensorFlow.js has these, but the library's types only list the parts it uses itself.
    const tf = faceapi.tf as unknown as { setBackend(name: string): Promise<boolean>; ready(): Promise<void> };
    // WebGL is far faster; the CPU fallback works everywhere but takes seconds per photo.
    if (!(await tf.setBackend('webgl').catch(() => false))) await tf.setBackend('cpu');
    await tf.ready();
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(__FACE_MODELS__),
      faceapi.nets.faceLandmark68Net.loadFromUri(__FACE_MODELS__),
      faceapi.nets.faceRecognitionNet.loadFromUri(__FACE_MODELS__),
    ]);
    return faceapi;
  })();
  loading.catch(() => (loading = null));
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

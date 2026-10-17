/**
 * Continuous scanning with the camera. A code held in view counts once; show it again after taking
 * it away (or the next spool of the same kind) and it counts again.
 */

/** A code that has been out of view this long counts again when it comes back. */
export const GONE_MS = 1200;

/** Decides which detections are new scans. Pure, so it can be tested without a camera. */
export class RepeatFilter {
  private seen = new Map<string, number>();

  accept(codes: string[], now: number): string[] {
    const fresh: string[] = [];
    for (const code of codes) {
      const last = this.seen.get(code);
      if (last === undefined || now - last > GONE_MS) fresh.push(code);
      this.seen.set(code, now);
    }
    for (const [code, t] of this.seen) if (now - t > GONE_MS * 4) this.seen.delete(code);
    return fresh;
  }
}

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

type Detect = (video: HTMLVideoElement) => Promise<string[]>;

const WANTED = ['qr_code', 'data_matrix', 'aztec', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];

async function nativeDetector(): Promise<Detect | null> {
  const Ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const supported = (await Ctor.getSupportedFormats?.()) ?? ['qr_code'];
    const formats = WANTED.filter((f) => supported.includes(f));
    if (!formats.includes('qr_code')) return null;
    const detector = new Ctor({ formats });
    return async (video) => (await detector.detect(video)).map((b) => b.rawValue).filter(Boolean);
  } catch {
    return null;
  }
}

async function jsqrDetector(): Promise<Detect> {
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return async (video) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return [];
    // A smaller frame decodes much faster and is still sharp enough for a label at arm's length.
    const scale = Math.min(1, 720 / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return hit?.data ? [hit.data] : [];
  };
}

export interface CameraScanner {
  stop(): void;
}

/** Starts the camera into `video` and calls `onCode` for every new code. Throws if there is no camera. */
export async function startCamera(video: HTMLVideoElement, onCode: (code: string) => void): Promise<CameraScanner> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-camera-api');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();

  const detect = (await nativeDetector()) ?? (await jsqrDetector());
  const filter = new RepeatFilter();
  let running = true;
  let timer = 0;

  const tick = async () => {
    if (!running) return;
    try {
      if (video.readyState >= 2) {
        for (const code of filter.accept(await detect(video), performance.now())) onCode(code);
      }
    } catch {
      // A frame that fails to decode is simply skipped.
    }
    if (running) timer = window.setTimeout(tick, 120);
  };
  tick();

  return {
    stop() {
      running = false;
      clearTimeout(timer);
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}

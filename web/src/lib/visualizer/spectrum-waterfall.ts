/**
 * Canvas 2D renderers for the spectrum + waterfall display.
 *
 * `SpectrumRenderer` draws a line plot of the latest FFT frame (top panel).
 * `WaterfallRenderer` maintains a scrolling image where each row is one
 * FFT frame, coloured by intensity (bottom panel).
 *
 * Performance-shaped:
 * - Both renderers reuse a single ImageData buffer; the waterfall does an
 *   in-place `copyWithin` to scroll, which is dramatically faster than
 *   drawImage onto itself.
 * - Colormap values are precomputed into a 256-entry LUT at construction.
 *
 * Target: 30 fps at 2048-bin FFT, 1024-px-wide canvases.
 */

export type RGB = [number, number, number];
export type ColormapName = 'viridis' | 'magma' | 'classic';

/** Viridis polynomial fit (https://www.shadertoy.com/view/WlfXRN). */
function viridis(t: number): RGB {
  t = clamp01(t);
  const r =
    0.2777273272 +
    t *
      (0.105093483 +
        t *
          (-0.330080973 +
            t * (-4.634230369 + t * (6.228269936 + t * (4.776384997 + t * -5.435455368)))));
  const g =
    0.005407344544 +
    t *
      (1.404613774 +
        t *
          (0.214847014 +
            t * (-5.799100973 + t * (14.17993049 + t * (-13.74514603 + t * 4.645852612)))));
  const b =
    0.3340498315 +
    t *
      (1.384590153 +
        t *
          (0.0959595256 +
            t * (-19.33244095 + t * (56.69055186 + t * (-65.353118 + t * 26.31242371)))));
  return [Math.floor(255 * clamp01(r)), Math.floor(255 * clamp01(g)), Math.floor(255 * clamp01(b))];
}

/** Magma polynomial fit. */
function magma(t: number): RGB {
  t = clamp01(t);
  const r =
    -0.002136485053 +
    t *
      (0.2516605407 +
        t *
          (8.353717544 +
            t * (-27.66873067 + t * (52.17613639 + t * (-50.76852536 + t * 18.65570520)))));
  const g =
    0.0002647053427 +
    t *
      (0.6557580497 +
        t *
          (-3.362634939 +
            t *
              (14.7270070 +
                t * (-32.13853129 + t * (30.43891266 + t * -10.30887641)))));
  const b =
    -0.005386778591 +
    t *
      (1.516141058 +
        t *
          (0.6580605107 +
            t * (-13.71759660 + t * (35.85236929 + t * (-39.42706963 + t * 16.05098041)))));
  return [Math.floor(255 * clamp01(r)), Math.floor(255 * clamp01(g)), Math.floor(255 * clamp01(b))];
}

/** "Classic" SDR waterfall: black → blue → cyan → green → yellow → red. */
function classic(t: number): RGB {
  t = clamp01(t);
  // 5 stops: 0 black, .25 blue, .5 cyan→green, .75 yellow, 1 red
  if (t < 0.25) {
    const u = t * 4;
    return [0, 0, Math.floor(255 * u)];
  }
  if (t < 0.5) {
    const u = (t - 0.25) * 4;
    return [0, Math.floor(255 * u), 255];
  }
  if (t < 0.75) {
    const u = (t - 0.5) * 4;
    return [Math.floor(255 * u), 255, Math.floor(255 * (1 - u))];
  }
  const u = (t - 0.75) * 4;
  return [255, Math.floor(255 * (1 - u)), 0];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const COLORMAPS: Record<ColormapName, (t: number) => RGB> = {
  viridis,
  magma,
  classic,
};

/** Build a 256-entry RGB LUT for a colormap. */
function buildLut(name: ColormapName): Uint8ClampedArray {
  const fn = COLORMAPS[name];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = fn(i / 255);
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

// ────────────────────────────────────────────────────────────────────────
// Spectrum line plot
// ────────────────────────────────────────────────────────────────────────

export type SpectrumOptions = {
  dbMin: number;
  dbMax: number;
  lineColor?: string;
  gridColor?: string;
  backgroundColor?: string;
};

export class SpectrumRenderer {
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private dbMin: number;
  private dbMax: number;
  private lineColor: string;
  private gridColor: string;
  private backgroundColor: string;

  constructor(canvas: HTMLCanvasElement, opts: SpectrumOptions) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context for spectrum canvas');
    this.ctx = ctx;
    this.width = canvas.width;
    this.height = canvas.height;
    this.dbMin = opts.dbMin;
    this.dbMax = opts.dbMax;
    this.lineColor = opts.lineColor ?? '#7dd3fc';
    this.gridColor = opts.gridColor ?? '#1f1f1f';
    this.backgroundColor = opts.backgroundColor ?? '#0a0a0a';
  }

  setRange(dbMin: number, dbMax: number): void {
    this.dbMin = dbMin;
    this.dbMax = dbMax;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.ctx.canvas.width = width;
    this.ctx.canvas.height = height;
  }

  draw(bins: Float32Array): void {
    const { ctx, width: w, height: h } = this;
    ctx.fillStyle = this.backgroundColor;
    ctx.fillRect(0, 0, w, h);

    // Horizontal grid lines every 10 dB (assuming dbMin..dbMax spans ~80 dB).
    ctx.strokeStyle = this.gridColor;
    ctx.lineWidth = 1;
    const span = this.dbMax - this.dbMin;
    const step = span >= 60 ? 10 : 5;
    for (let db = Math.ceil(this.dbMin / step) * step; db <= this.dbMax; db += step) {
      const y = h - h * ((db - this.dbMin) / span);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Vertical centre line (DC).
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();

    // Spectrum trace.
    ctx.strokeStyle = this.lineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = bins.length;
    for (let x = 0; x < w; x++) {
      const binIdx = Math.floor((x * n) / w);
      const db = bins[binIdx];
      const y = h - h * clamp01((db - this.dbMin) / span);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// ────────────────────────────────────────────────────────────────────────
// Waterfall
// ────────────────────────────────────────────────────────────────────────

export type WaterfallOptions = {
  dbMin: number;
  dbMax: number;
  colormap: ColormapName;
};

export class WaterfallRenderer {
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private dbMin: number;
  private dbMax: number;
  private imageData: ImageData;
  private buf: Uint8ClampedArray;
  private lut: Uint8ClampedArray;

  constructor(canvas: HTMLCanvasElement, opts: WaterfallOptions) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context for waterfall canvas');
    this.ctx = ctx;
    this.width = canvas.width;
    this.height = canvas.height;
    this.dbMin = opts.dbMin;
    this.dbMax = opts.dbMax;
    this.imageData = ctx.createImageData(this.width, this.height);
    this.buf = this.imageData.data;
    this.lut = buildLut(opts.colormap);

    // Initialize background to mid-LUT (looks cleaner than transparent black).
    const bgIdx = 0;
    for (let i = 0; i < this.buf.length; i += 4) {
      this.buf[i] = this.lut[bgIdx];
      this.buf[i + 1] = this.lut[bgIdx + 1];
      this.buf[i + 2] = this.lut[bgIdx + 2];
      this.buf[i + 3] = 255;
    }
    ctx.putImageData(this.imageData, 0, 0);
  }

  setRange(dbMin: number, dbMax: number): void {
    this.dbMin = dbMin;
    this.dbMax = dbMax;
  }

  setColormap(name: ColormapName): void {
    this.lut = buildLut(name);
  }

  push(bins: Float32Array): void {
    const { width: w, height: h } = this;

    // Scroll existing rows down by 1 — in-place memmove. Row 0 (oldest) is
    // overwritten next.
    this.buf.copyWithin(w * 4, 0, w * (h - 1) * 4);

    // Render new row from bins into row 0.
    const span = this.dbMax - this.dbMin;
    const n = bins.length;
    for (let x = 0; x < w; x++) {
      const binIdx = Math.floor((x * n) / w);
      const db = bins[binIdx];
      const t = clamp01((db - this.dbMin) / span);
      const lutIdx = Math.floor(t * 255) * 4;
      const off = x * 4;
      this.buf[off] = this.lut[lutIdx];
      this.buf[off + 1] = this.lut[lutIdx + 1];
      this.buf[off + 2] = this.lut[lutIdx + 2];
      this.buf[off + 3] = 255;
    }

    this.ctx.putImageData(this.imageData, 0, 0);
  }
}

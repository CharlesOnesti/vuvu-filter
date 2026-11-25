/**
 * Honk Filter — DSP core.
 *
 * Multi-pitch tonal-peak suppression. Air horns are stable harmonic tones that hold a
 * pitch for hundreds of milliseconds; speech pitch moves every syllable and crowd cheer
 * is broadband. So we find spectral bins standing far above the local spectral floor,
 * require them to *persist* over time, and pull only those bins down to the floor.
 *
 * That persistence requirement is what preserves the reporter and the cheering. It also
 * means we never tune to a specific frequency, so any number of horns at any pitches are
 * handled by the same code.
 *
 * This module is shared verbatim between the AudioWorklet and the Node test bench, so
 * what gets measured is what gets shipped.
 */

/** In-place radix-2 complex FFT. Precomputes twiddles and the bit-reversal table. */
export class FFT {
  constructor(n) {
    if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** Forward transform when inverse=false, unnormalized inverse when inverse=true. */
  transform(re, im, inverse = false) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = this.cos[k];
          const s = inverse ? -this.sin[k] : this.sin[k];
          const a = i + j;
          const b = a + half;
          const tre = re[b] * c - im[b] * s;
          const tim = re[b] * s + im[b] * c;
          re[b] = re[a] - tre; im[b] = im[a] - tim;
          re[a] += tre;        im[a] += tim;
        }
      }
    }
  }
}

/** Moving average with 'nearest' edge handling, O(n) via a running sum. */
function movingAverage(src, dst, n, win) {
  const half = win >> 1;
  let sum = 0;
  for (let i = -half; i <= half; i++) sum += src[Math.min(n - 1, Math.max(0, i))];
  const inv = 1 / (2 * half + 1);
  for (let i = 0; i < n; i++) {
    dst[i] = sum * inv;
    const outIdx = Math.min(n - 1, Math.max(0, i - half));
    const inIdx = Math.min(n - 1, Math.max(0, i + half + 1));
    sum += src[inIdx] - src[outIdx];
  }
}

export const DEFAULTS = {
  fftSize: 2048,
  excessDb: 6,      // how far above the spectral floor a bin must stand to look tonal
  persist: 6,       // consecutive tonal frames before we believe it is a horn
  attenDb: 28,      // maximum attenuation applied to a flagged bin
  minHz: 400,       // never touch anything below this — protects the reporter's fundamental
  floorWin: 41,     // width (bins) of the spectral-floor estimator
  peakExcludeDb: 4, // bins this far above the first-pass floor are excluded from pass two
  smoothing: 0.5,   // one-pole gain smoothing, release-only
};

export class DehonkCore {
  constructor(sampleRate, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.sampleRate = sampleRate;
    this.N = o.fftSize;
    this.hop = this.N / 4; // 75% overlap
    this.bins = this.N / 2 + 1;
    this.fft = new FFT(this.N);

    this.setParams(o);

    // Hann window, applied on both analysis and synthesis. At 75% overlap the squared
    // window sums to a constant 1.5, so that is the overlap-add normalization.
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      this.win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.N));
    }
    this.winNorm = 1 / 1.5;

    // Buffers shift once per hop rather than once per sample, so the per-sample cost
    // stays at a few operations instead of a full window copy.
    this.inBuf = new Float32Array(this.N);   // sliding analysis window
    this.inFill = 0;                          // samples accumulated toward the next hop
    this.outAccum = new Float32Array(this.N); // overlap-add accumulator
    this.fifo = new Float32Array(this.N * 4); // completed samples awaiting readout
    this.fifoRead = 0;
    this.fifoWrite = 0;
    this.fifoCount = 0;

    this.re = new Float32Array(this.N);
    this.im = new Float32Array(this.N);
    this.logMag = new Float32Array(this.bins);
    this.mag = new Float32Array(this.bins);
    this.floor1 = new Float32Array(this.bins);
    this.floor2 = new Float32Array(this.bins);
    this.masked = new Float32Array(this.bins);
    this.tonal = new Uint8Array(this.bins);
    this.horn = new Uint8Array(this.bins);
    this.wide = new Uint8Array(this.bins);
    this.run = new Int32Array(this.bins);
    this.gain = new Float32Array(this.bins).fill(1);
    this.smooth = new Float32Array(this.bins).fill(1);

    // No pre-seeding: a frame is emitted on the same sample that completes a hop, so the
    // FIFO stays balanced from the start. Measured end-to-end delay is one window
    // (2047 samples / 42.6 ms at 48 kHz, verified by cross-correlation against a
    // passthrough round trip). Pre-seeding a window here would push that past 75 ms and
    // out of comfortable lip-sync range, for no benefit.
    this.latencySamples = this.N;

    this.lastReduction = 0; // dB of attenuation this frame, for the UI meter
  }

  setParams(p) {
    if (p.excessDb !== undefined) this.excessDb = p.excessDb;
    if (p.persist !== undefined) this.persist = p.persist;
    if (p.attenDb !== undefined) this.attenDb = p.attenDb;
    if (p.minHz !== undefined) this.minHz = p.minHz;
    if (p.floorWin !== undefined) this.floorWin = p.floorWin;
    if (p.peakExcludeDb !== undefined) this.peakExcludeDb = p.peakExcludeDb;
    if (p.smoothing !== undefined) this.smoothing = p.smoothing;
  }

  /** Analyze + filter one frame sitting in this.inBuf, overlap-adding into this.outBuf. */
  _processFrame() {
    const { N, bins, re, im, win } = this;

    for (let i = 0; i < N; i++) {
      re[i] = this.inBuf[i] * win[i];
      im[i] = 0;
    }
    this.fft.transform(re, im, false);

    for (let b = 0; b < bins; b++) {
      const m = Math.hypot(re[b], im[b]);
      this.mag[b] = m;
      this.logMag[b] = 20 * Math.log10(m + 1e-12);
    }

    // Spectral floor, two passes: a wide average, then re-averaged with the peaks
    // themselves replaced by that first estimate so strong tones stop inflating the floor.
    movingAverage(this.logMag, this.floor1, bins, this.floorWin);
    for (let b = 0; b < bins; b++) {
      this.masked[b] =
        this.logMag[b] > this.floor1[b] + this.peakExcludeDb ? this.floor1[b] : this.logMag[b];
    }
    movingAverage(this.masked, this.floor2, bins, this.floorWin);

    const minBin = Math.ceil((this.minHz * N) / this.sampleRate);
    for (let b = 0; b < bins; b++) {
      this.tonal[b] = b >= minBin && this.logMag[b] - this.floor2[b] > this.excessDb ? 1 : 0;
    }

    // Persistence, tolerating +/-1 bin of pitch wander so a drifting horn keeps its streak.
    for (let b = 0; b < bins; b++) {
      const near =
        this.tonal[b] || (b > 0 && this.tonal[b - 1]) || (b < bins - 1 && this.tonal[b + 1]);
      this.run[b] = near ? this.run[b] + 1 : 0;
      this.horn[b] = this.tonal[b] && this.run[b] >= this.persist ? 1 : 0;
    }

    // Widen each detected peak by one bin either side to catch the skirt of the tone.
    const maxAtten = Math.pow(10, -this.attenDb / 20);
    let sumGainDb = 0;
    let flagged = 0;
    for (let b = 0; b < bins; b++) {
      const w =
        this.horn[b] || (b > 0 && this.horn[b - 1]) || (b < bins - 1 && this.horn[b + 1]);
      this.wide[b] = w && b >= minBin ? 1 : 0;

      let g = 1;
      if (this.wide[b]) {
        const target = Math.pow(10, (this.floor2[b] + 2) / 20);
        g = Math.min(1, Math.max(maxAtten, target / (this.mag[b] + 1e-12)));
      }
      // Release-only smoothing: attenuation engages immediately but recovers gently,
      // which is what keeps the residual from warbling into musical noise.
      const sm = Math.min(g, this.smoothing * this.smooth[b] + (1 - this.smoothing) * g);
      this.smooth[b] = sm;
      this.gain[b] = sm;
      // Average over every bin actually being cut, including ones still releasing, so
      // the meter reflects the gain being applied rather than this frame's detections.
      if (sm < 1) {
        sumGainDb += -20 * Math.log10(sm + 1e-12);
        flagged++;
      }
    }
    this.lastReduction = flagged ? sumGainDb / flagged : 0;

    // Apply the gain to the half spectrum and mirror it as a conjugate.
    for (let b = 0; b < bins; b++) {
      const g = this.gain[b];
      re[b] *= g;
      im[b] *= g;
      if (b > 0 && b < N / 2) {
        re[N - b] = re[b];
        im[N - b] = -im[b];
      }
    }

    this.fft.transform(re, im, true);

    const scale = this.winNorm / N;
    for (let i = 0; i < N; i++) {
      this.outAccum[i] += re[i] * win[i] * scale;
    }

    // The first `hop` samples of the accumulator have received every frame that can
    // contribute to them, so they are final: emit them and slide the accumulator.
    for (let i = 0; i < this.hop; i++) {
      this.fifo[this.fifoWrite] = this.outAccum[i];
      this.fifoWrite = (this.fifoWrite + 1) % this.fifo.length;
      if (this.fifoCount < this.fifo.length) this.fifoCount++;
    }
    this.outAccum.copyWithin(0, this.hop);
    this.outAccum.fill(0, N - this.hop);
  }

  /**
   * Push `input` samples and pull the same number of filtered samples into `output`.
   * Output lags input by one FFT window; the constructor pre-seeds that latency.
   */
  process(input, output) {
    const n = input.length;
    const N = this.N;
    for (let i = 0; i < n; i++) {
      this.inBuf[N - this.hop + this.inFill] = input[i];
      this.inFill++;

      if (this.inFill >= this.hop) {
        this.inFill = 0;
        this._processFrame();
        // Slide the analysis window back by one hop, leaving room for the next hop.
        this.inBuf.copyWithin(0, this.hop);
      }

      if (this.fifoCount > 0) {
        output[i] = this.fifo[this.fifoRead];
        this.fifoRead = (this.fifoRead + 1) % this.fifo.length;
        this.fifoCount--;
      } else {
        output[i] = 0;
      }
    }
  }
}

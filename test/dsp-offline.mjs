/**
 * Offline DSP tests for DehonkCore.
 *
 * Run: node test/dsp-offline.mjs
 *
 * Asserts:
 *  - Synthetic 660 Hz horn is attenuated; 150 Hz speech band is preserved
 *  - Sample Full_Honking ogg: 600–700 Hz drops substantially; 80–300 Hz stays ~flat
 *  - Disabled / bypass-equivalent passthrough is near bit-exact after latency settle
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DehonkCore, DEFAULTS } from '../src/common/dehonk-core.js';
import { strengthToParams } from '../src/common/params.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SR = 48000;
const PCM_DIR = '/tmp/honk-test-audio';

function ensurePcm(oggName, outName) {
  mkdirSync(PCM_DIR, { recursive: true });
  const out = join(PCM_DIR, outName);
  if (existsSync(out)) return out;
  const ogg = join(ROOT, oggName);
  execFileSync(
    'ffmpeg',
    ['-y', '-i', ogg, '-ac', '1', '-ar', String(SR), '-f', 'f32le', out],
    { stdio: 'ignore' }
  );
  return out;
}

let passed = 0;
let failed = 0;
const results = [];

function assert(name, cond, detail = '') {
  if (cond) {
    passed++;
    results.push({ name, ok: true, detail });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    results.push({ name, ok: false, detail });
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Inline FFT for measurement (same algorithm as production)
class MeasFFT {
  constructor(n) {
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
  transform(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = this.cos[k];
          const s = this.sin[k];
          const a = i + j;
          const b = a + half;
          const tre = re[b] * c - im[b] * s;
          const tim = re[b] * s + im[b] * c;
          re[b] = re[a] - tre;
          im[b] = im[a] - tim;
          re[a] += tre;
          im[a] += tim;
        }
      }
    }
  }
}

function bandRmsDb(samples, sampleRate, loHz, hiHz) {
  const N = 2048;
  const fft = new MeasFFT(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
  const lo = Math.ceil((loHz * N) / sampleRate);
  const hi = Math.floor((hiHz * N) / sampleRate);
  let power = 0;
  let frames = 0;
  for (let start = 0; start + N <= samples.length; start += N) {
    for (let i = 0; i < N; i++) {
      re[i] = samples[start + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let b = lo; b <= hi && b <= N / 2; b++) {
      power += re[b] * re[b] + im[b] * im[b];
    }
    frames++;
  }
  if (!frames || power <= 0) return -120;
  return 10 * Math.log10(power / frames + 1e-20);
}

function processAll(input, sampleRate, params) {
  const core = new DehonkCore(sampleRate, { ...DEFAULTS, ...params });
  const out = new Float32Array(input.length);
  const block = 128;
  for (let i = 0; i < input.length; i += block) {
    const end = Math.min(input.length, i + block);
    const inn = input.subarray(i, end);
    const chunk = new Float32Array(inn.length);
    core.process(inn, chunk);
    out.set(chunk, i);
  }
  // Drop the latency head so band metrics compare settled audio
  const skip = core.latencySamples + 2048;
  return { out, skip, core };
}

function loadF32(path) {
  const buf = readFileSync(path);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function synthTonePlusSpeech(seconds = 2) {
  const n = Math.floor(SR * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const speech = 0.25 * Math.sin(2 * Math.PI * 150 * t); // voice-ish fundamental
    const horn = 0.55 * Math.sin(2 * Math.PI * 660 * t); // air-horn fundamental
    const h2 = 0.2 * Math.sin(2 * Math.PI * 1320 * t);
    // mild noise floor so spectral floor estimator has something to work with
    const noise = (Math.random() * 2 - 1) * 0.02;
    x[i] = speech + horn + h2 + noise;
  }
  return x;
}

console.log('\n=== Honk Filter DSP offline tests ===\n');

// --- 1. strength mapping lands on validated defaults at 50 ---
{
  console.log('1) strengthToParams');
  const p = strengthToParams(50, 400);
  assert('strength 50 → excessDb ≈ 6', Math.abs(p.excessDb - 6) < 1e-9, `got ${p.excessDb}`);
  assert('strength 50 → persist = 6', p.persist === 6, `got ${p.persist}`);
  assert('strength 50 → attenDb ≈ 28', Math.abs(p.attenDb - 28) < 1e-9, `got ${p.attenDb}`);
  assert('strength 50 → minHz = 400', p.minHz === 400, `got ${p.minHz}`);
}

// --- 2. Synthetic tone + speech ---
{
  console.log('\n2) Synthetic 660 Hz horn + 150 Hz speech');
  const input = synthTonePlusSpeech(2.5);
  const params = strengthToParams(50, 400);
  const { out, skip } = processAll(input, SR, params);
  const inn = input.subarray(skip);
  const ou = out.subarray(skip);

  const voiceIn = bandRmsDb(inn, SR, 80, 300);
  const voiceOut = bandRmsDb(ou, SR, 80, 300);
  const hornIn = bandRmsDb(inn, SR, 600, 700);
  const hornOut = bandRmsDb(ou, SR, 600, 700);
  const dVoice = voiceOut - voiceIn;
  const dHorn = hornOut - hornIn;

  assert(
    'voice 80–300 Hz change ≥ -1.5 dB (preserved)',
    dVoice >= -1.5,
    `Δ=${dVoice.toFixed(2)} dB (in ${voiceIn.toFixed(1)} → out ${voiceOut.toFixed(1)})`
  );
  assert(
    'horn 600–700 Hz attenuated ≥ 8 dB',
    dHorn <= -8,
    `Δ=${dHorn.toFixed(2)} dB (in ${hornIn.toFixed(1)} → out ${hornOut.toFixed(1)})`
  );
  assert(
    'horn cut deeper than voice damage',
    dHorn < dVoice - 6,
    `horn Δ ${dHorn.toFixed(2)} vs voice Δ ${dVoice.toFixed(2)}`
  );
}

// --- 3. Real Full_Honking sample ---
{
  console.log('\n3) Sample Full_Honking_Noise_Sound');
  const pcmPath = ensurePcm('Full_Honking_Noise_Sound.ogg', 'full_honk.f32');
  const input = loadF32(pcmPath);
  const params = strengthToParams(50, 400);
  const { out, skip } = processAll(input, SR, params);
  const inn = input.subarray(skip);
  const ou = out.subarray(skip);

  const voiceIn = bandRmsDb(inn, SR, 80, 300);
  const voiceOut = bandRmsDb(ou, SR, 80, 300);
  const hornIn = bandRmsDb(inn, SR, 600, 700);
  const hornOut = bandRmsDb(ou, SR, 600, 700);
  const h2In = bandRmsDb(inn, SR, 1300, 1350);
  const h2Out = bandRmsDb(ou, SR, 1300, 1350);
  const dVoice = voiceOut - voiceIn;
  const dHorn = hornOut - hornIn;
  const dH2 = h2Out - h2In;

  assert(
    'full_honk voice band Δ ≥ -2 dB',
    dVoice >= -2,
    `Δ=${dVoice.toFixed(2)} dB`
  );
  assert(
    'full_honk horn 600–700 Δ ≤ -10 dB',
    dHorn <= -10,
    `Δ=${dHorn.toFixed(2)} dB`
  );
  assert(
    'full_honk 2nd harmonic 1300–1350 Δ ≤ -5 dB',
    dH2 <= -5,
    `Δ=${dH2.toFixed(2)} dB`
  );
}

// --- 4. Sample with speech under honking ---
{
  console.log('\n4) Sample Honking_but_with_meaningful_info');
  const input = loadF32(ensurePcm('Honking_but_with_meaninful_info_sound.ogg', 'honk_speech.f32'));
  const params = strengthToParams(50, 400);
  const { out, skip } = processAll(input, SR, params);
  const inn = input.subarray(skip);
  const ou = out.subarray(skip);

  const voiceIn = bandRmsDb(inn, SR, 80, 300);
  const voiceOut = bandRmsDb(ou, SR, 80, 300);
  const hornIn = bandRmsDb(inn, SR, 600, 700);
  const hornOut = bandRmsDb(ou, SR, 600, 700);
  const dVoice = voiceOut - voiceIn;
  const dHorn = hornOut - hornIn;

  assert(
    'speech+horn voice band Δ ≥ -2 dB',
    dVoice >= -2,
    `Δ=${dVoice.toFixed(2)} dB`
  );
  assert(
    'speech+horn horn 600–700 Δ ≤ -8 dB',
    dHorn <= -8,
    `Δ=${dHorn.toFixed(2)} dB`
  );
}

// --- 5. Near bit-exact when no bins are suppressed ---
{
  console.log('\n5) Passthrough integrity (no tonal detections)');
  const input = synthTonePlusSpeech(1.2);
  const { out, core } = processAll(input, SR, {
    excessDb: 80,
    persist: 99,
    attenDb: 0,
    minHz: 400,
  });
  // Find best integer lag near the declared latency (OLA delay is ~one window).
  const declare = core.latencySamples;
  let bestLag = declare;
  let bestCorr = -Infinity;
  for (let lag = declare - 64; lag <= declare + 64; lag++) {
    if (lag < 0) continue;
    let corr = 0;
    const n = Math.min(input.length - lag, 8000);
    for (let i = 0; i < n; i++) corr += out[i + lag] * input[i];
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  let errPower = 0;
  let refPower = 0;
  for (let i = 0; i + bestLag < out.length && i < input.length; i++) {
    const ref = input[i];
    const e = out[i + bestLag] - ref;
    errPower += e * e;
    refPower += ref * ref;
  }
  const errDb = 10 * Math.log10(errPower / (refPower + 1e-20) + 1e-20);
  assert(
    'near-passthrough error ≤ -60 dB when nothing is cut',
    errDb <= -60,
    `err=${errDb.toFixed(1)} dB @ lag=${bestLag} (declared ${declare})`
  );
}

// --- 6. Manifest / source gates ---
{
  console.log('\n6) Extension packaging (no Facebook-only gate)');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const hosts = [
    ...(manifest.host_permissions || []),
    ...((manifest.content_scripts || []).flatMap((c) => c.matches || [])),
  ].join(' ');
  assert('no host_permissions Facebook-only lock', !(manifest.host_permissions || []).length, JSON.stringify(manifest.host_permissions || []));
  assert(
    'content_scripts not Facebook-gated',
    !hosts.includes('facebook.com') || (manifest.permissions || []).includes('tabCapture'),
    hosts || '(none)'
  );
  assert('has tabCapture permission', (manifest.permissions || []).includes('tabCapture'));
  assert('has offscreen permission', (manifest.permissions || []).includes('offscreen'));
  assert('minimum_chrome_version ≥ 116', Number(manifest.minimum_chrome_version) >= 116);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

// Write machine-readable summary for TEST-RESULTS.md assembly
writeFileSync(
  join(__dirname, 'dsp-offline-results.json'),
  JSON.stringify({ passed, failed, results, at: new Date().toISOString() }, null, 2)
);

process.exit(failed ? 1 : 0);

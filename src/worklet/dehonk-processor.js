/**
 * AudioWorklet wrapper around the shared DSP core.
 *
 * Runs on the audio render thread, so it must never allocate or block in process().
 * All buffers are allocated up front by DehonkCore; parameter changes arrive over the
 * message port and are applied by reference between blocks.
 */
import { DehonkCore } from '../common/dehonk-core.js';

class DehonkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.cores = [];
    this.bypass = !!opts.bypass;
    this.params = opts.params || {};
    this.meterCounter = 0;

    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'params') {
        this.params = { ...this.params, ...msg.params };
        for (const c of this.cores) c.setParams(this.params);
      } else if (msg.type === 'bypass') {
        this.bypass = !!msg.value;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output) return true;

    // No input yet (element not playing) — emit silence but stay alive.
    if (!input || input.length === 0) {
      for (const ch of output) ch.fill(0);
      return true;
    }

    // One core per *input* channel, so stereo images stay independent.
    while (this.cores.length < input.length) {
      this.cores.push(new DehonkCore(sampleRate, this.params));
    }

    // Each core must be advanced exactly once per block. Mono sources feeding a stereo
    // output are the common case here, so filter every input channel once and then fan
    // the results out — running one core twice would feed it the same samples twice and
    // desync its internal buffers.
    let reduction = 0;
    const filtered = Math.min(input.length, output.length);
    for (let ch = 0; ch < filtered; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      if (!inCh) {
        outCh.fill(0);
        continue;
      }
      if (this.bypass) {
        outCh.set(inCh);
      } else {
        const core = this.cores[ch];
        core.process(inCh, outCh);
        reduction = Math.max(reduction, core.lastReduction);
      }
    }
    // Duplicate the last filtered channel into any surplus output channels.
    for (let ch = filtered; ch < output.length; ch++) {
      if (filtered > 0) output[ch].set(output[filtered - 1]);
      else output[ch].fill(0);
    }

    // Report the working level to the popup a few times a second, not every block.
    if (++this.meterCounter >= 12) {
      this.meterCounter = 0;
      this.port.postMessage({ type: 'meter', reduction: this.bypass ? 0 : reduction });
    }
    return true;
  }
}

registerProcessor('dehonk-processor', DehonkProcessor);

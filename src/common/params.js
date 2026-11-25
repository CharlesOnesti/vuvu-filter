/**
 * Single source of truth for settings, shared by the popup and the content script.
 *
 * The UI exposes one Strength knob; these are the three DSP parameters it actually drives.
 * The endpoints come from a measured sweep over the two sample recordings (horn = 600-700
 * Hz fundamental, collateral = 2-4 kHz consonants and 6-12 kHz cheer):
 *
 *   strength   excess / persist / atten   horn           consonants   cheer
 *   0          8 / 8 / 21                 -11 to -15 dB  -2.2 dB      -0.2 dB
 *   50         6 / 6 / 28                 -14 to -19 dB  -3.4/-3.9    -1.0 dB
 *   100        4 / 4 / 35                 -15 to -20 dB  -5.3/-6.3    -2.4/-2.9
 *
 * The voice fundamental (80-300 Hz) measures 0.0 dB at every setting, because nothing
 * below minHz is ever touched.
 *
 * Note the diminishing returns: going 50 -> 100 buys only another ~1-4 dB on the horn but
 * roughly doubles the damage to the commentator's consonants. That is why 50 is the
 * default rather than something more aggressive.
 */

export const DEFAULT_SETTINGS = {
  enabled: true,
  bypass: false,
  strength: 50,
  minHz: 400,
};

/** Map the 0-100 Strength control onto DSP parameters. */
export function strengthToParams(strength, minHz = DEFAULT_SETTINGS.minHz) {
  const t = Math.max(0, Math.min(100, Number(strength) || 0)) / 100;
  const lerp = (a, b) => a + (b - a) * t;
  // Endpoints are chosen so that strength 50 lands exactly on the validated defaults
  // (excess 6 dB / persist 6 frames / atten 28 dB), not merely near them.
  return {
    excessDb: lerp(8, 4),
    persist: Math.max(1, Math.round(lerp(8, 4))),
    attenDb: lerp(21, 35),
    minHz: Number(minHz) || DEFAULT_SETTINGS.minHz,
  };
}

export function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
      resolve({ ...DEFAULT_SETTINGS, ...stored });
    });
  });
}

export function saveSettings(patch) {
  return new Promise((resolve) => chrome.storage.sync.set(patch, resolve));
}

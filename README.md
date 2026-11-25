# Honk Filter (All Sites)

Chrome MV3 extension that suppresses stadium **air-horn / vuvuzela-like tonal noise** on
**any normal Chrome video tab** while keeping commentators and crowd atmosphere.

Built for sports streams on **YouTube, Tennis Channel, Fubo, Fox Sports, Twitch, Facebook**,
and similar sites — not Facebook-only.

**Version:** `2.0.0` (see `manifest.json`)

DSP is adapted from [Honk Filter / video-noise-suppression](https://github.com/kalaounmohamad/video-noise-suppression)
(multi-pitch tonal-peak suppression / STFT). Capture architecture follows the
**tabCapture → offscreen document** pattern used by tools like Whistle Filter / Commentary Off.

## Download (zip)

Grab the latest unpacked extension zip from the
[GitHub Releases](https://github.com/CharlesOnesti/vuvu-filter/releases) page:

- **Release:** https://github.com/CharlesOnesti/vuvu-filter/releases/tag/2.0.0
- **Zip:** https://github.com/CharlesOnesti/vuvu-filter/releases/download/2.0.0/honk-filter-all-sites-2.0.0.zip

Unzip it, then use **Load unpacked** on the extracted folder (the one that contains `manifest.json`).

## Install (unpacked)

### From the zip

1. Download and unzip `honk-filter-all-sites-2.0.0.zip`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked**.
5. Select the unzipped folder (the folder that contains `manifest.json`).
6. Pin the extension. Open a playing video tab, click the icon, then **Start on this tab**.

### From this repository

1. Clone: `git clone https://github.com/CharlesOnesti/vuvu-filter.git`
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the **repo root** (the folder that contains `manifest.json`).
5. Pin the extension. Open a playing video tab, click the icon, then **Start on this tab**.

Requires **Chrome 116+** (service worker `tabCapture.getMediaStreamId` → offscreen).

## Using it

1. Start playback on the sports stream tab.
2. Click the extension icon on that tab (this is the required user gesture).
3. Click **Start on this tab** (or flip the enable switch).
4. Tune **Strength** while horns are sounding (~50 is the usual sweet spot).
5. Hold **Hold to hear the original** to A/B.
6. **Protect voice below** (Advanced): raise if the announcer sounds thin; lower if low horns leak through.

The toolbar badge shows `ON` for tab-capture mode, or `EL` for the HTML5 element fallback.

## Which audio path is used?

| Path | When | Works on |
| --- | --- | --- |
| **Primary — tabCapture → offscreen AudioWorklet** | Default when you click Start | Most Chrome tabs that are playing audible audio, including many DRM / EME sports players (Fubo, Fox Sports, Tennis Channel, etc.) where `createMediaElementSource` fails |
| **Fallback — MediaElementSource** | If tabCapture fails, or you check **Force MediaElementSource** | Simple HTML5 `<video>`/`<audio>` and many YouTube embeds |

**Why tabCapture for DRM sites?**  
`createMediaElementSource()` needs direct access to the page media element. Protected players
often block that. `chrome.tabCapture` taps the **tab’s mixed audio after decode** (browser
process), then an offscreen document runs the same dehonk worklet and plays filtered audio
back out. Capturing a tab mutes its normal speaker path until we reconnect it — this
extension always routes capture → DSP → `AudioContext.destination`.

## Honest limits

- **You must activate on the playing tab** (click the icon / Start). tabCapture is gated on
  extension invocation, like `activeTab`.
- **Some Widevine / EME apps still yield a silent capture stream** (classic example: Netflix).
  If the status says capture is running but audio looks silent, that player is not exposing
  tab audio — no extension can filter what Chrome does not deliver.
- **Sports streamers vary.** Fubo / Fox Sports / Tennis Channel often work with tabCapture
  because audio reaches the tab mix; they usually fail MediaElementSource. If a specific
  app is silent under capture, that is a Chrome/CDM limitation, not a missing notch filter.
- **Tonal horns, not broadband noise.** Persistent harmonic air-horns/vuvuzelas are cut;
  diffuse roar and speech fundamentals (below the protect-Hz floor) are preserved. Expect
  “much less piercing,” not “studio silence.”
- **One active filtered tab** at a time in this build.
- Reloading the page may end a session — click Start again.

## Automated tests

```bash
mkdir -p /tmp/honk-test-audio
ffmpeg -y -i Full_Honking_Noise_Sound.ogg -ac 1 -ar 48000 -f f32le /tmp/honk-test-audio/full_honk.f32
ffmpeg -y -i Honking_but_with_meaninful_info_sound.ogg -ac 1 -ar 48000 -f f32le /tmp/honk-test-audio/honk_speech.f32
node test/dsp-offline.mjs
```

Latest run write-up: [TEST-RESULTS.md](./TEST-RESULTS.md).

## How the DSP works

Multi-pitch tonal-peak suppression (same core as upstream Honk Filter):

1. STFT frames (2048 samples, 75% overlap).
2. Estimate local spectral floor.
3. Flag bins far above the floor as tonal candidates.
4. Require persistence across frames (horns hold pitch; speech does not).
5. Attenuate only those bins down toward the floor; never touch bins below **Protect voice below**.

## Layout

```
manifest.json
icons/
src/common/dehonk-core.js      STFT / tonal suppression DSP
src/common/params.js           Strength → DSP mapping + storage
src/worklet/dehonk-processor.js AudioWorklet wrapper
src/offscreen/                 Primary: tabCapture audio graph
src/background/service-worker.js Capture orchestration + fallback
src/content/content.js         MediaElementSource fallback
src/popup/                     Enable, strength, protect-Hz, hold-to-hear, status
test/bench.html                Offline samples
*.ogg                          Sample honk recordings
```

## Privacy

All processing is local in the browser. Audio is not recorded, uploaded, or sent to a server.
Tab capture exists only to filter playback for the current user.

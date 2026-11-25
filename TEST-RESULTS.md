# Honk Filter (All Sites) — test results

**When:** Tuesday, Nov 24, 2026, 1:44 PM America/New_York (EST)  
**Extension:** v2.0.0 at `/cursor/stores/self/docs/honk-filter-all-sites/`  
**Verdict:** **PASS** for automated DSP + Chrome E2E on non-Facebook HTML5 via tabCapture. Live Fubo/Fox/Tennis Channel DRM not exercised (no credentials).

---

## 1. Automated DSP core — PASS (18/18)

**Command:**

```bash
# Prefetch samples to float32 (once):
ffmpeg -y -i Full_Honking_Noise_Sound.ogg -ac 1 -ar 48000 -f f32le /tmp/honk-test-audio/full_honk.f32
ffmpeg -y -i Honking_but_with_meaninful_info_sound.ogg -ac 1 -ar 48000 -f f32le /tmp/honk-test-audio/honk_speech.f32

node test/dsp-offline.mjs
```

**Machine-readable:** `/cursor/stores/self/docs/honk-filter-all-sites/test/dsp-offline-results.json`  
(also copied under `test/evidence/`)

| Suite | Result | Notes |
| --- | --- | --- |
| strengthToParams @ 50 | PASS | excess 6 / persist 6 / atten 28 / minHz 400 |
| Synthetic 660 Hz horn + 150 Hz speech | PASS | voice Δ **0.00 dB**; horn Δ **−28.0 dB** |
| Sample `Full_Honking_Noise_Sound` | PASS | voice Δ −0.10 dB; horn 600–700 **−19.2 dB**; 2nd harm **−9.9 dB** |
| Sample speech-under-honk | PASS | voice Δ 0.00 dB; horn **−13.1 dB** |
| Passthrough (no detections) | PASS | OLA error **−139.4 dB** @ lag 2047 |
| Packaging (no Facebook-only gate) | PASS | no `host_permissions`; has `tabCapture` + `offscreen`; MV ≥ 116 |

---

## 2. Chrome E2E (real browser) — PASS

**Environment:** Google Chrome 157 on the VM desktop (CDP port 9399).  
**Load method:** Developer mode + CDP `Extensions.loadUnpacked` for `/tmp/honk-filter-ext` (copy of the deliverable). CLI `--load-extension` is blocked on Chrome 157 even with `DisableLoadExtensionCommandLineSwitch`; UI “Load unpacked” file picker was flaky — CDP load succeeded and chrome://extensions showed the extension cleanly (no Errors).

**Page:** `http://127.0.0.1:8765/test/e2e-player.html` — local HTML5, **not** facebook.com / fb.watch.

**Steps verified:**

1. Extension listed as **Honk Filter (All Sites) — stadium horn suppressor** v2.0.0, enabled, service worker present.
2. Played clip 2 (“Honking over speech”).
3. Opened popup → **Start on this tab**.
4. Status became: **“Filtering tab audio. Horns should drop; voice should stay.”**
5. Mode: **“Tab audio capture (DRM-friendly)”** (primary path, not MediaElementSource).
6. Toolbar badge **ON**; Working meter showed **−2.0 dB** (filter actively cutting).
7. **No Facebook-only messaging** anywhere in the popup.

### Evidence screenshots

| File | What it shows |
| --- | --- |
| `/cursor/stores/self/docs/honk-filter-all-sites/test/evidence/a-extensions.webp` | chrome://extensions with extension loaded |
| `/cursor/stores/self/docs/honk-filter-all-sites/test/evidence/b-e2e-player.webp` | Non-Facebook E2E player with audio playing |
| `/cursor/stores/self/docs/honk-filter-all-sites/test/evidence/c-popup-after-start.webp` | Popup after Start: tabCapture mode, −2.0 dB meter, ON badge |
| `/cursor/stores/self/docs/honk-filter-all-sites/test/evidence/c2-popup-later.webp` | Same session still filtering a moment later |

PNG copies of the same frames are alongside the webp files when conversion succeeded.

---

## 3. Fixes applied during verification

| Issue | Fix |
| --- | --- |
| Offline passthrough assert failed (−20 dB) due to lag mis-alignment | Cross-correlate near declared latency; now **−139.4 dB** PASS |
| Chrome 157 ignores `--load-extension` | Documented; E2E used Developer mode / CDP `loadUnpacked` (same as user Load unpacked) |

No product-code failures remained after the passthrough test fix.

---

## 4. Remaining gaps (not failures of this build)

| Gap | Why |
| --- | --- |
| Live **Fubo / Fox Sports / Tennis Channel** | No account credentials on the VM; cannot log into those DRM players here |
| Subjective A/B listen on VM | No usable ALSA playback device in the test environment; meter + DSP band metrics used instead |
| YouTube live stream | Not required once local HTML5 + tabCapture path proved; optional follow-up for the user |
| Netflix-class silent Widevine | Expected limitation (documented in README); not re-tested |

---

## 5. How to re-run

```bash
cd /cursor/stores/self/docs/honk-filter-all-sites
mkdir -p /tmp/honk-test-audio
ffmpeg -y -i Full_Honking_Noise_Sound.ogg -ac 1 -ar 48000 -f f32le /tmp/honk-test-audio/full_honk.f32
ffmpeg -y -i Honking_but_with_meaninful_info_sound.ogg -ac 1 -ar 48000 -f f32le /tmp/honk-test-audio/honk_speech.f32
node test/dsp-offline.mjs

# Manual browser check:
# chrome://extensions → Load unpacked → this folder
# open test/e2e-player.html (via any static server) → Start on this tab
```

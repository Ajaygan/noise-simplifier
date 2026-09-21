# Noise Simplifier

Meeting voice cleaner. It removes the noise that arrives with other people's
voices — fans, air conditioning, keyboards, traffic, room tone — and keeps the
speech. It works on **any** meeting that plays in a browser tab (Google Meet,
Zoom, Teams, Jitsi, Discord, Whereby…), because it processes the tab's audio
instead of relying on the meeting app.

There are two halves:

| | where | what it is for |
|---|---|---|
| **Browser extension** (Chrome, MV3) | `extension/` | real-time cleaning while you are in a call. Runs in an `AudioWorklet`, so the audio never leaves the machine and there is no network latency. |
| **Python backend** | `python/` | offline cleaning of recordings, batch jobs, and a small HTTP service. Also the place to experiment with the filters. |

Both sides share one settings vocabulary and the same idea: estimate the noise
spectrum, attenuate it, keep the voice band, optionally ride the level. The
offline engine is stronger (it sees the whole file, so it can smooth the
periodogram and iterate on the estimate), while the browser engine is causal and
cheap enough to run 30 times a second inside a worklet.

```
tab audio ─▶ MediaStreamTrack ─▶ AudioWorklet ─▶ RNNoise (WASM) ─▶ spectral
                                                     │                │
                                                     └──── voice band + AGC ──▶ speakers / meeting mic
```

---

## 1. Extension: install and use

The extension is unpacked (no store build), so you load it once:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder of this repository.
4. Pin **Noise Simplifier** to the toolbar.

Then, in a call:

1. Join the meeting and make sure the tab is the one playing the voices.
2. Click the extension icon → **Clean this tab**. Chrome will ask to share the
   tab's audio — allow it. (Or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>.)
3. Talk normally. The badge shows **ON** while cleaning is active.

**Use headphones.** Chrome captures *and mutes* the tab's own output, so what you
hear is the cleaned audio played back by the extension. Without headphones, your
microphone can pick up that playback and echo it back into the call.

### The popup

| Control | What it does |
|---|---|
| **Engine** | `RNNoise` (cheapest, great on fans and hiss), `Spectral` (fully adjustable), `Hybrid` (default: RNNoise then the spectral stage on what is left) |
| **Strength** | how deep the suppression may go (maps to 12–36 dB of maximum attenuation) |
| **Presets** | quiet room / balanced / loud office / soft voice |
| **Voice focus** | band-limits to 95 Hz – 7.6 kHz and lifts 2.6 kHz, i.e. keeps the speech band and drops rumble plus hiss |
| **Auto gain** | rides quiet talkers up to a steady level (−6…+15 dB) |
| **Hold to hear the original** | live A/B against the untouched audio, at the same latency |

Meters show input and output level and how far the noise sits below the voice.
Everything is stored in `chrome.storage.local` and applied live.

### How it is built

* `extension/src/dsp/` — the DSP: `spectral.js` (STFT, noise estimation, gains),
  `rnnoise-engine.js` (WASM wrapper), `engine.js` (mode facade).
* `extension/src/worklets/denoise.worklet.src.js` — the worklet source. It is
  flattened together with the DSP and the vendored RNNoise build into
  `extension/dist/denoise.worklet.js`. **Edit the source, then rebuild:**
  ```bash
  node tools/build-worklets.mjs           # writes extension/dist/denoise.worklet.js
  node tools/build-worklets.mjs --check   # fails if the dist file is stale
  ```
* `extension/src/background.js` — session lifecycle (`chrome.tabCapture`),
  offscreen document, badge, keyboard shortcut, state mirroring.
* `extension/src/offscreen/` — owns the audio graph (capture → worklet → output).
* `extension/src/popup/` — the UI.
* `extension/vendor/rnnoise.esm.js` — RNNoise compiled to WASM (Apache-2.0, see
  `RNNOISE-WASM-LICENSE.txt`).

Requires Chrome 116+ (AudioWorklet + offscreen document APIs).

### Troubleshooting

* **"not compiled for this environment (did you build to HTML and try to run it
  not on the web, …)"** in the popup — the vendored RNNoise build is
  `-sENVIRONMENT=web`, so it starts by feature-testing
  `typeof window == "object" || typeof WorkerGlobalScope < "u"`.
  Chrome's `AudioWorkletGlobalScope` has neither, and the bundle used to throw
  before it was shimmed: `denoise.worklet.src.js` publishes a `WorkerGlobalScope`
  stand-in before the vendored module is evaluated (the WASM is embedded as
  base64 and instantiates synchronously, so nothing else in that build needs a
  DOM). If you see this message it means Chrome loaded a **stale or hand-edited**
  `extension/dist/denoise.worklet.js`: run `node tools/build-worklets.mjs`, then
  hit reload on `chrome://extensions`.
* **No audio after starting** — Chrome only hands over tab audio once the tab is
  actually playing sound, so start the capture while the meeting is talking. Use
  headphones: with speakers the cleaned audio goes back into your microphone.
* **Alt+Shift+N does nothing** — the shortcut only works while a Chrome window is
  focused; use the popup button instead.

---

## 2. Python: recordings, batches, service

```bash
/opt/nsvenv/bin/python -m pip install -e python[io,service]   # or: pip install -e python[io,service]
```

### Command line

```bash
python -m noisesimplifier meeting.wav                    # writes meeting.clean.wav
python -m noisesimplifier recordings/ --strength 0.85 --auto-gain
python -m noisesimplifier take.flac --out take.clean.flac --no-voice-focus
```

```
recordings/call.wav  ->  recordings/call.clean.wav
  48000 Hz, 1 ch, 32.0 s  |  suppression  18.3 dB  |  noise floor  -41.7 dB
```

### HTTP service

```bash
cd python && /opt/nsvenv/bin/python -m uvicorn app:app --port 8765

# clean a file in place (paths must stay under NOISE_SIMPLIFIER_ROOT)
curl -s -X POST "http://127.0.0.1:8765/denoise/file?path=meeting.wav&strength=0.8"

# or stream raw audio in and cleaned audio out
curl -s -X POST "http://127.0.0.1:8765/denoise/raw?sample_rate=48000&dtype=float32" \
     --data-binary @meeting.raw --output meeting.clean.raw
```

The response headers `x-noise-simplifier-noise-floor-db` and
`x-noise-simplifier-suppression-db` report what happened. `GET /health` lists the
available backends.

### Library

```python
import soundfile as sf
from noisesimplifier import SpectralDenoiser, SpectralSettings

audio, sr = sf.read("meeting.wav")            # (samples,) or (samples, channels)
denoiser = SpectralDenoiser(sr, SpectralSettings(strength=0.8, auto_gain=True))
quiet = denoiser.denoise_channels(audio.T).T
sf.write("meeting.clean.wav", quiet, sr)
print(denoiser.metrics())                     # {'noiseFloorDb': ..., 'suppressionDb': ...}
```

The extension does **not** call the service: live meeting audio cannot survive a
network round-trip, so real-time cleaning happens in the browser. The service is
for recordings and for tuning the same algorithm from Python.

### Offline engine, in one paragraph

A Hann-windowed STFT (1024/256 at 48 kHz) is low-passed over ~10 frames, and a
low percentile of each bin seeds the noise estimate. A Gerkmann–Hendriks speech
presence probability then re-weights every frame — frames that look like speech
are down-weighted, frames that look like noise are averaged in — and the
weighted mean is iterated a few times. Because the seed is deliberately low, the
estimate can only grow towards the noise mean, which is the safe direction to be
wrong in. Gains are Wiener-style (`xi/(1+xi)`), raised to a strength exponent,
floored at `max_attenuation_db × strength`, then smoothed across frequency and
time (fast attack, slow release) so the residual stays natural instead of
becoming musical tones. A voice-focus filter, an optional AGC and a
sample-exact latency alignment finish the job.

---

## 3. Measured results

Run them yourself:

```bash
node --test tests/spectral.test.mjs tests/worklet.test.mjs   # 18 tests, extension DSP + worklet
node tools/quality-metrics.mjs                                # objective harness
cd python && python -m pytest tests -q                        # 29 tests, offline backend + service
```

The signals are synthetic (harmonic speech with formants and pauses, Kellet pink
noise, white noise, keyboard clicks), so treat the numbers as a regression guard,
not as a listening test.

**Extension (spectral core, default settings, 4 s, 0 dB SNR):**

| noise | noise reduction | segSNR | speech level | click reduction |
|---|---|---|---|---|
| white (fan, hiss) | 15.1 dB | 8.10 dB | −0.3 dB | 1.7 dB |
| pink (traffic, room) | 3.3 dB | 2.80 dB | −2.0 dB | 1.7 dB |

The 1.7 dB column is clicks *mixed under* speech, where the voice dominates the
frame energy. Measured on their own, keyboard clicks are suppressed 8–12 dB by
the transient gate while the voice is left at 0.00 dB change.

**Python (default settings, 6 s speech with pauses):**

| noise | noise reduction |
|---|---|
| white noise alone | 18.9 dB |
| pink noise alone | 18.3 dB |

| speech at | segSNR in → out | voice level change |
|---|---|---|
| 0 dB SNR | 0.96 → 3.24 dB | −4.6 dB |
| 10 dB SNR | 10.93 → 12.63 dB | −0.6 dB |
| 20 dB SNR | 20.93 → 22.42 dB | −0.1 dB |

The last row is the one that matters for "keep the voice": when the noise is
already quiet, the processor is transparent to within 0.1 dB and the SNR does
not get worse.

---

## 4. Tuning

`python/noisesimplifier/backends/spectral.py` (the `SpectralSettings` dataclass)
and `extension/src/dsp/spectral.js` (the `DEFAULTS` object) document every knob:

| knob | effect |
|---|---|
| `strength` | 0–1, scales the maximum attenuation. Lower = gentler. |
| `max_attenuation_db` | how far a single bin may be pushed down (26 dB default) |
| `over_subtraction` | subtract a little more than the estimate; deeper holes, more risk |
| `gain_exponent` | >1 leans harder on the residual |
| `power_smoothing` | offline only: centred periodogram average, the single biggest lever on how deep the gains can go |
| `noise_percentile`, `noise_iterations`, `noise_weight_power` | offline noise estimation |
| `voice_focus`, `highpass_hz`, `lowpass_hz`, `presence_db` | the speech band |
| `auto_gain` | level riding for quiet talkers |

`node tools/tune.mjs` runs a grid search over the extension's knobs and prints
the objective metrics for each configuration.

---

## 5. Project layout

```
extension/
  manifest.json               MV3 manifest
  dist/denoise.worklet.js     generated worklet bundle (do not edit)
  icons/                      generated PNG icons
  src/
    settings.js               shared settings model (also used by the popup)
    background.js             service worker: sessions, capture, badge, shortcut
    offscreen/                audio graph (capture → worklet → output)
    popup/                    popup UI
    dsp/                      spectral denoiser, RNNoise wrapper, engine facade
    worklets/denoise.worklet.src.js
  vendor/                     RNNoise WASM build (Apache-2.0)
python/
  app.py                      FastAPI service
  noisesimplifier/
    backends/spectral.py      offline two-pass denoiser
    cli.py                    command line
  tests/                      offline backend + service tests
tests/                        Node test suites and signal generators
tools/                        worklet bundler, icon generator, quality metrics, tuner
```

## 6. Limitations

* Chrome only (MV3 APIs: `tabCapture`, offscreen documents, AudioWorklet).
* Tab audio is captured mono-summed by the worklet pipeline; both output
  channels receive the same cleaned signal.
* The extension adds 480 samples (RNNoise), 512 (spectral) or 992 (hybrid) of
  latency — 10–21 ms, inaudible in a conversation but nonzero.
* RNNoise is trained on 48 kHz speech; other sample rates go through the same
  worklet (the engine adapts the analysis window, the model still sees 48 kHz
  frames).
* Speech that is always on and never pauses (no gaps at all) is the hardest case
  for any noise estimator; the offline engine handles it by biasing towards
  keeping the voice.

## 7. Licensing

MIT for this project (see `LICENSE`). RNNoise is BSD-3-Clause; the WASM build in
`extension/vendor/` is Apache-2.0 (see `extension/vendor/RNNOISE-WASM-LICENSE.txt`).

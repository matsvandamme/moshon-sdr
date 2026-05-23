# Hardware Test Plan

Manual end-to-end verification for every supported dongle.
Use one column per session; tick boxes as you go.

## Setup

- Latest build: <https://moshon-sdr.pages.dev>
- Browser: Chrome / Edge / Brave (WebUSB)
- Headphones or speaker with the **physical volume turned low** before the
  first start — the soft limiter caps at ±1.0 but tuning into a strong AM
  carrier without squelch is still loud.
- Optional: a known-quiet HF band and a known-busy 2 m repeater locally.

If WebUSB doesn't see the dongle on Windows, install WinUSB via Zadig.
The Setup modal in the header has per-OS instructions.

---

## Common smoke test (run first, any dongle)

| # | Check | Expected |
|---|-------|----------|
| 1 | Page loads | "DSP smoke test: 42" badge visible |
| 2 | Header shows mode chip & device label | "RTL-SDR" / "HackRF" / "Network" |
| 3 | `?` key opens shortcut help | Modal lists hotkeys |
| 4 | Press `Esc` | Modal closes |
| 5 | Refresh after tuning to 102.1 MHz / WFM | URL `#f=...&m=wfm` survives, dial restored |

---

## Per-dongle matrix

### RTL-SDR (R820T / R820T2) — generic dongles, NESDR SMArt, etc.

| # | Step | Expected |
|---|------|----------|
| R1 | Click **Connect**, pick the dongle | Status flips to *connected* |
| R2 | Sample rate dropdown | Shows 1.92 / 2.4 / 2.88 MS/s |
| R3 | Start, leave on 100 MHz | Waterfall scrolls; no console errors |
| R4 | Stats counter | Bytes-written grows ≈ 4.8 MB/s at 2.4 MS/s |
| R5 | Tune to a local FM broadcast | Audio comes through, stereo dot lights when pilot present |
| R6 | RDS panel | PI/PS appears within ~10 s on a clean station |
| R7 | Switch to NFM, tune a 2 m repeater | Discriminator audio |
| R8 | Squelch (SQ on, threshold ~-40 dBFS) | Hash silences between transmissions; SQ dot is green during keying |
| R9 | AM, tune medium-wave or aviation | Envelope-detected audio, no carrier thump |
| R10 | USB / LSB on the 20 m band | Voice readable if a signal is present |
| R11 | CW, tune the CW portion | Audible tone at ~700 Hz on keying |
| R12 | Offset tuning ON (250 kHz) | DC spike moves off-centre; no audio degradation |
| R13 | PPM correction +/- 30 | Visible drift on a known carrier; rev to 0 after |
| R14 | Bias-T toggle (if your antenna can tolerate 4.5 V) | Toggle does not crash; **do not enable on a dumb antenna** |
| R15 | Direct sampling Q, tune <24 MHz | HF spectrum visible (no tuner involved) |
| R16 | Stop & Disconnect | Counter freezes, status idle |

### RTL-SDR Blog V3 / V4 (R828D)

Same as R1-R16, plus:

| # | Step | Expected |
|---|------|----------|
| B1 | Direct-sampling **off** at HF on a V4 | Built-in upconverter handles HF, no DS needed |
| B2 | Tune to 50 MHz | Branding string reads "RTLSDRBlog Blog V4" if you have a V4 |

### Nooelec NeSDR Smartee XTR (E4000)

The detection chain probes E4000 **after** R820T but **before** R828D, so
a fresh open should land on the E4000 driver.

| # | Step | Expected |
|---|------|----------|
| X1 | Connect → Start at 100 MHz | No `setRegBuffer failed block=0x600 reg=74` error |
| X2 | Console (devtools open while connecting) | No tuner-detection errors |
| X3 | Tune across VHF (88-108, 145 MHz, 433 MHz) | PLL retunes smoothly, no clicks |
| X4 | Tune above 1.1 GHz (e.g. 1090 MHz ADS-B) | Spectrum still alive — band switches to "L" range |
| X5 | Bias-T tee on (XTR is 4.5 V) | Toggle works, doesn't crash |
| X6 | Manual gain slider through full range | Audible step changes; no clipping |

### HackRF One

| # | Step | Expected |
|---|------|----------|
| H1 | Connect → click "Read device info" | Board ID = `HackRF One`, firmware version + 16-hex serial |
| H2 | Sample-rate dropdown | All 13 presets from 2 → 20 MS/s present, 8 MS/s labelled "recommended floor" |
| H3 | Start at 2.4 MS/s, 100 MHz | Bytes-written ≈ 4.8 MB/s, no console errors |
| H4 | Switch to 10 MS/s while streaming | Hits the stop-restart path; sample-rate update visible in counter |
| H5 | 20 MS/s, watch dropped-bytes counter | Should stay at 0 on a desktop; some drops acceptable on a laptop |
| H6 | AMP toggle (+11 dB) | Audible level jump |
| H7 | LNA slider 0-40 dB step 8 | Smooth gain change |
| H8 | VGA slider 0-62 dB step 2 | Smooth gain change |
| H9 | Antenna power on (3 V / 50 mA) | Toggle works (do not enable on a passive dipole) |
| H10 | Baseband filter override (e.g. 5 MHz at 4 MS/s) | Spectrum becomes visibly narrower |
| H11 | Tune across 1 MHz - 6 GHz | All ranges produce a spectrum (check 100 MHz, 1.090 GHz, 2.4 GHz) |

### rtl_tcp network bridge

| # | Step | Expected |
|---|------|----------|
| N1 | Start `moshon-bridge` locally with default flags | Listens on `0.0.0.0:9090` |
| N2 | Browser → Network tab → Bridge URL = `http://127.0.0.1:9090` | Connects, status streaming |
| N3 | rtl_tcp target field empty | Bridge dials its default target |
| N4 | Tune / change gain / change sample rate | 5-byte commands round-trip to rtl_tcp |
| N5 | Verify URL hash does NOT contain bridge URL | (Privacy — the bridge URL lives in localStorage only) |
| N6 | Bridge URL persists after refresh, but is not in `#…` | localStorage only |

---

## Cross-cutting feature checks (any dongle)

These don't depend on the tuner chip; pick one dongle and step through.

| # | Feature | How to verify |
|---|---------|---------------|
| F1 | Spectrum colormap | Cycle viridis / magma / classic via dropdown |
| F2 | dB range sliders | Min/max drag adjusts waterfall contrast |
| F3 | Keyboard shortcuts | `F`/`M`/`B`/`G`/`,`/`.`/`[`/`]`/`Space` per the help modal |
| F4 | VFO dial drag | Click-drag adjusts dial; scroll-wheel steps |
| F5 | Click-to-tune on waterfall | Single click jumps to that frequency |
| F6 | IARU band overlay | Coloured strip above the freq axis |
| F7 | S-meter | Updates while streaming, S-units sensible |
| F8 | Memory channels | Save current → "Recall" jumps back |
| F9 | Sweep mode | Set 88-108 MHz, run sweep — wide spectrum builds left→right |
| F10 | ADS-B | Tune mode = ADS-B (auto-jumps to 1090 MHz), aircraft list populates with good antenna |
| F11 | LoRa monitor | Mode = LoRa, auto-jumps 868.1 MHz, panel shows channel-power |
| F12 | Audio recording | Rec → speak / play → Stop → .wav file downloads, plays back correctly |
| F13 | WFM de-emphasis 50 µs vs 75 µs | Pill toggle in audio row; flip on a strong station — 75 µs sounds duller on top end |
| F14 | NFM/AM squelch | Toggle SQ on, set ~-40 dBFS; dot is green only on keying |
| F15 | Audio AGC | Toggle "AGC" pill; weak stations come up, strong ones don't blow out |
| F16 | DC block / limiter | Tune to a strong AM, retune away — no thumping pop |

---

## When to file an issue

- Spectrum stays empty for >5 s after Start (USB error or DSP crash)
- Audio underruns persistently above 0 (browser CPU bound or buffer too tight)
- `setRegBuffer failed` or `tuner chip` errors (driver mismatch — capture
  the exact error string and the dongle USB ID)
- Sample rate selection changes the **bytes-written** rate by a different
  factor than expected (suggests the dongle silently clamped)
- AGC pumps audibly (attack/release tuning may need adjustment for your
  signal profile)

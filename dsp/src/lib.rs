//! Moshon SDR DSP core.
//!
//! Compiles to WebAssembly via `wasm-pack build --target web`. Consumed by
//! `web/src/lib/dsp/`. Real signal processing (FFT, filtering, demodulation)
//! lands in milestones B3+. v0.1 ships a smoke export only.

#![forbid(unsafe_code)]
#![warn(clippy::pedantic)]

use wasm_bindgen::prelude::*;

/// Smoke-test export. Returns a deterministic value so the web app can verify
/// the WASM module loaded and exports are callable. Replaced by real DSP
/// exports in B3/B4.
#[wasm_bindgen]
#[must_use]
pub fn smoke() -> u32 {
    42
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke_returns_known_value() {
        assert_eq!(smoke(), 42);
    }
}

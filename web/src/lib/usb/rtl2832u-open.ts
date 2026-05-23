/**
 * Open an RTL2832U-based dongle, including E4000-tuner variants.
 *
 * Upstream `@jtarrio/webrtlsdr` only detects R820T and R828D tuners. The
 * Nooelec NeSDR Smartee XTR (and older NESDR Mini, R820T-era dongles
 * reflashed as E4000, etc.) use the Elonics E4000. This wrapper mirrors
 * `RTL2832U.open()` exactly but adds [[e4000-tuner]] to the detection
 * chain after R828D.
 *
 * Implementation: the upstream `RTL2832U` class has a private constructor
 * and private static helpers (`_init`, `_findTuner`). Both are accessible
 * at runtime — TS visibility is compile-time only — so we cast through
 * `unknown` to call them. If upstream renames these symbols we'll get a
 * runtime error pointing here; that's acceptable for a pinned dependency.
 */

import { RTL2832U, type RtlDevice } from '@jtarrio/webrtlsdr/rtlsdr.js';
import { RtlCom } from '@jtarrio/webrtlsdr/rtlsdr/rtlcom.js';
import { R820T } from '@jtarrio/webrtlsdr/rtlsdr/r820t.js';
import { R828D } from '@jtarrio/webrtlsdr/rtlsdr/r828d.js';
import type { Tuner } from '@jtarrio/webrtlsdr/rtlsdr/tuner.js';
import { RadioError, RadioErrorType } from '@jtarrio/webrtlsdr/errors.js';
import { E4000 } from './e4000-tuner';

type Rtl2832uPrivate = {
  _init(com: RtlCom): Promise<void>;
  new (com: RtlCom, tuner: Tuner): RtlDevice & {
    gain: number | null;
    ppm: number;
    setGain(g: number | null): Promise<void>;
    setFrequencyCorrection(ppm: number): Promise<void>;
  };
};

export async function openRtl2832U(device: USBDevice): Promise<RtlDevice> {
  const Cls = RTL2832U as unknown as Rtl2832uPrivate;
  const com = new RtlCom(device);
  await com.claimInterface();
  await Cls._init(com);

  let tuner: Tuner | null = await R820T.maybeInit(com);
  if (tuner === null) tuner = await R828D.maybeInit(com);
  if (tuner === null) tuner = await E4000.maybeInit(com);
  if (tuner === null) {
    await com.releaseInterface();
    throw new RadioError(
      'Sorry, your USB dongle has an unsupported tuner chip.',
      RadioErrorType.UnsupportedDevice,
    );
  }

  const rtl = new Cls(com, tuner);
  await rtl.setGain(rtl.gain);
  await rtl.setFrequencyCorrection(rtl.ppm);
  return rtl;
}

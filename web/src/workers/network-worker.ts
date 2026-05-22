/**
 * Network Worker — opens a WebSocket to the moshon-bridge daemon, which
 * proxies to a remote `rtl_tcp` server. Parses the 12-byte rtl_tcp dongle-info
 * header on first read, then streams IQ bytes into the same SAB ring layout
 * the DSP worker drains.
 *
 * Outbound rtl_tcp commands are 5 bytes each: 1-byte opcode + 4-byte
 * big-endian uint32 parameter. Defined in osmocom's rtl_tcp source.
 */

import { SabRing } from '../lib/ring/sab-ring';

type InboundInit = {
  kind: 'init';
  /** WebSocket URL of the bridge, e.g. `ws://127.0.0.1:9090/ws?target=...`. */
  url: string;
  iqRing: SharedArrayBuffer;
  sampleRate: number;
  centerFreq: number;
  gain: number | null;
};
type InboundRetune = { kind: 'retune'; centerFreq?: number; gain?: number | null };
type InboundStop = { kind: 'stop' };
type Inbound = InboundInit | InboundRetune | InboundStop;

type OutboundStarted = {
  kind: 'started';
  /** From the dongle header. 0 = E4000, 1 = FC0012, 2 = FC0013, 3 = FC2580, 4 = R820T, 5 = R828D. */
  tunerType: number;
  /** Number of supported manual gain settings. */
  tunerGainCount: number;
};
type OutboundStats = {
  kind: 'stats';
  bytesWritten: number;
  bytesDropped: number;
  time: number;
};
type OutboundStopped = { kind: 'stopped' };
type OutboundError = { kind: 'error'; message: string };
type Outbound = OutboundStarted | OutboundStats | OutboundStopped | OutboundError;

// rtl_tcp opcodes — only what we use, names match osmocom source.
const CMD_SET_FREQ = 0x01;
const CMD_SET_SAMPLE_RATE = 0x02;
const CMD_SET_GAIN_MODE = 0x03; // 0 = auto (AGC), 1 = manual
const CMD_SET_GAIN = 0x04; // tenths of dB

const HEADER_BYTES = 12;
const STATS_INTERVAL_MS = 250;

let ws: WebSocket | null = null;
let ring: SabRing | null = null;
let running = false;
let bytesWritten = 0;
let bytesDropped = 0;
let lastStatsAt = 0;
let pendingHeader: Uint8Array | null = null;

function postOut(msg: Outbound) {
  self.postMessage(msg);
}

function sendCommand(opcode: number, param: number) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const buf = new ArrayBuffer(5);
  const view = new DataView(buf);
  view.setUint8(0, opcode);
  // rtl_tcp expects big-endian, signed allowed (frequency fits in u32 for sub-4 GHz).
  view.setUint32(1, Math.max(0, Math.round(param)) >>> 0, false);
  ws.send(buf);
}

function applyTuning(centerFreq?: number, gain?: number | null) {
  if (centerFreq !== undefined) {
    sendCommand(CMD_SET_FREQ, centerFreq);
  }
  if (gain !== undefined) {
    if (gain === null) {
      sendCommand(CMD_SET_GAIN_MODE, 0); // AGC
    } else {
      sendCommand(CMD_SET_GAIN_MODE, 1); // manual
      sendCommand(CMD_SET_GAIN, gain * 10); // tenths of dB
    }
  }
}

function handleHeader(bytes: Uint8Array): Uint8Array | null {
  if (pendingHeader) {
    const combined = new Uint8Array(pendingHeader.length + bytes.length);
    combined.set(pendingHeader, 0);
    combined.set(bytes, pendingHeader.length);
    pendingHeader = null;
    return processHeader(combined);
  }
  return processHeader(bytes);
}

function processHeader(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < HEADER_BYTES) {
    pendingHeader = bytes;
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  // Bytes 0..3: ASCII "RTL0". Bytes 4..7: tuner type. Bytes 8..11: gain count.
  const tunerType = view.getUint32(4, false);
  const tunerGainCount = view.getUint32(8, false);
  postOut({ kind: 'started', tunerType, tunerGainCount });
  return bytes.length === HEADER_BYTES ? new Uint8Array(0) : bytes.subarray(HEADER_BYTES);
}

function maybePostStats() {
  const now = performance.now();
  if (now - lastStatsAt < STATS_INTERVAL_MS) return;
  lastStatsAt = now;
  postOut({ kind: 'stats', bytesWritten, bytesDropped, time: now });
}

async function setup(opts: InboundInit): Promise<void> {
  ring = new SabRing(opts.iqRing);
  bytesWritten = 0;
  bytesDropped = 0;
  pendingHeader = null;
  let headerParsed = false;

  ws = new WebSocket(opts.url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    // Tell rtl_tcp what we want. Order matters: sample rate first, then freq.
    sendCommand(CMD_SET_SAMPLE_RATE, opts.sampleRate);
    applyTuning(opts.centerFreq, opts.gain);
    running = true;
  };

  ws.onmessage = (e) => {
    if (!ring || !running) return;
    if (!(e.data instanceof ArrayBuffer)) return;
    const initial = new Uint8Array(e.data);
    let payload: Uint8Array;
    if (!headerParsed) {
      const rest = handleHeader(initial);
      if (rest === null) return; // waiting for more header bytes
      headerParsed = true;
      if (rest.length === 0) return;
      payload = rest;
    } else {
      payload = initial;
    }
    const written = ring.write(payload);
    bytesWritten += written;
    if (written < payload.length) {
      bytesDropped += payload.length - written;
    }
    maybePostStats();
  };

  ws.onerror = () => {
    if (running) {
      postOut({ kind: 'error', message: 'WebSocket error (check bridge / CORS / target)' });
    }
  };

  ws.onclose = (e) => {
    running = false;
    if (!headerParsed) {
      postOut({
        kind: 'error',
        message: `WebSocket closed before stream started (code ${e.code}${e.reason ? `: ${e.reason}` : ''})`,
      });
      return;
    }
    postOut({ kind: 'stopped' });
  };
}

function shutdown() {
  running = false;
  if (ws && ws.readyState <= WebSocket.OPEN) {
    try {
      ws.close(1000, 'client stop');
    } catch {
      // ignore
    }
  }
  ws = null;
  ring = null;
}

self.onmessage = (e: MessageEvent<Inbound>) => {
  const msg = e.data;
  switch (msg.kind) {
    case 'init':
      void setup(msg);
      break;
    case 'retune':
      applyTuning(msg.centerFreq, msg.gain);
      break;
    case 'stop':
      shutdown();
      break;
  }
};

/**
 * Single-producer single-consumer byte ring buffer over `SharedArrayBuffer`.
 *
 * Layout:
 *   bytes 0..3   : writePos (Atomic Int32, mod 2 * capacity)
 *   bytes 4..7   : readPos  (Atomic Int32, mod 2 * capacity)
 *   bytes 8..n   : body of `capacity` bytes
 *
 * The 2*capacity modulus lets us distinguish "empty" (w == r) from "full"
 * ((w - r) mod 2N == N) without reserving a sentinel byte.
 *
 * Backpressure policy: if the producer tries to write more than there is
 * room for, the excess is dropped silently. We surface drops via the
 * `dropped` counter (read with `getDropped()`). For Moshon SDR's IQ flow,
 * dropping older samples in a backlog is preferable to blocking the USB
 * worker.
 */

const HEADER_BYTES = 8;
const WRITE_POS_INDEX = 0;
const READ_POS_INDEX = 1;

export class SabRing {
  private readonly sab: SharedArrayBuffer;
  private readonly header: Int32Array;
  private readonly body: Uint8Array;
  private readonly capacity: number;
  private readonly mod: number;
  private droppedLocal = 0;

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.header = new Int32Array(sab, 0, 2);
    this.body = new Uint8Array(sab, HEADER_BYTES);
    this.capacity = this.body.length;
    this.mod = this.capacity * 2;
  }

  /** Allocate a fresh ring with `capacity` bytes of payload space. */
  static create(capacity: number): SabRing {
    const sab = new SharedArrayBuffer(HEADER_BYTES + capacity);
    return new SabRing(sab);
  }

  /** The underlying buffer — postMessage this to other workers. */
  get buffer(): SharedArrayBuffer {
    return this.sab;
  }

  /** Reset to empty. Single-threaded operation; call before producers/consumers run. */
  reset(): void {
    Atomics.store(this.header, WRITE_POS_INDEX, 0);
    Atomics.store(this.header, READ_POS_INDEX, 0);
    this.droppedLocal = 0;
  }

  /** Bytes currently in the ring, readable by the consumer. */
  available(): number {
    const w = Atomics.load(this.header, WRITE_POS_INDEX);
    const r = Atomics.load(this.header, READ_POS_INDEX);
    return (w - r + this.mod) % this.mod;
  }

  /**
   * Write up to `data.length` bytes. Returns the number actually written.
   * Any excess is dropped (and counted in `getDropped()`).
   */
  write(data: Uint8Array): number {
    const w = Atomics.load(this.header, WRITE_POS_INDEX);
    const r = Atomics.load(this.header, READ_POS_INDEX);
    const used = (w - r + this.mod) % this.mod;
    const free = this.capacity - used;
    const toWrite = Math.min(data.length, free);

    if (toWrite > 0) {
      const wIdx = w % this.capacity;
      const tail = Math.min(toWrite, this.capacity - wIdx);
      this.body.set(data.subarray(0, tail), wIdx);
      if (toWrite > tail) {
        this.body.set(data.subarray(tail, toWrite), 0);
      }
      Atomics.store(this.header, WRITE_POS_INDEX, (w + toWrite) % this.mod);
    }

    if (toWrite < data.length) {
      this.droppedLocal += data.length - toWrite;
    }

    return toWrite;
  }

  /** Read up to `out.length` bytes from the ring. Returns the number actually read. */
  read(out: Uint8Array): number {
    const w = Atomics.load(this.header, WRITE_POS_INDEX);
    const r = Atomics.load(this.header, READ_POS_INDEX);
    const used = (w - r + this.mod) % this.mod;
    const toRead = Math.min(out.length, used);

    if (toRead > 0) {
      const rIdx = r % this.capacity;
      const tail = Math.min(toRead, this.capacity - rIdx);
      out.set(this.body.subarray(rIdx, rIdx + tail), 0);
      if (toRead > tail) {
        out.set(this.body.subarray(0, toRead - tail), tail);
      }
      Atomics.store(this.header, READ_POS_INDEX, (r + toRead) % this.mod);
    }

    return toRead;
  }

  /** Producer-side count of bytes dropped due to a full ring. Resets on reset(). */
  getDropped(): number {
    return this.droppedLocal;
  }

  /** Total payload capacity in bytes. */
  getCapacity(): number {
    return this.capacity;
  }
}

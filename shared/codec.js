// ---------------------------------------------------------------------------
// Binary codec.
//
// Writer grows a buffer; Reader refuses to read past the end of one.
//
// The Reader is the security-relevant half. `JSON.parse` inside a try/catch
// fails safely on garbage; a hand-rolled decoder that reads a count and then
// allocates before checking it does not. Every read here calls need() first,
// and every count is validated against the bytes actually remaining via
// expect() BEFORE anything is allocated. A malformed frame throws, and the
// caller drops the connection.
//
// Little-endian throughout, on both ends.
// ---------------------------------------------------------------------------

const ENC = new TextEncoder();
const DEC = new TextDecoder();

export const U8_MAX = 0xff;
export const U16_MAX = 0xffff;
export const U32_MAX = 0xffffffff;

export const clampU8 = v => (v < 0 ? 0 : v > U8_MAX ? U8_MAX : v | 0);
export const clampU16 = v => (v < 0 ? 0 : v > U16_MAX ? U16_MAX : v | 0);
export const clampU32 = v => (v < 0 ? 0 : v > U32_MAX ? U32_MAX : v >>> 0);

export class Writer {
  constructor(initial = 2048) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
    this.o = 0;
  }

  ensure(n) {
    if (this.o + n <= this.buf.length) return;
    let cap = this.buf.length || 64;
    while (cap < this.o + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v) { this.ensure(1); this.view.setUint8(this.o, clampU8(v)); this.o += 1; return this; }
  u16(v) { this.ensure(2); this.view.setUint16(this.o, clampU16(v), true); this.o += 2; return this; }
  u32(v) { this.ensure(4); this.view.setUint32(this.o, clampU32(v), true); this.o += 4; return this; }
  i16(v) { this.ensure(2); this.view.setInt16(this.o, Math.max(-32768, Math.min(32767, v | 0)), true); this.o += 2; return this; }
  f32(v) { this.ensure(4); this.view.setFloat32(this.o, v, true); this.o += 4; return this; }

  // Length-prefixed UTF-8, capped so a single string can never dominate a frame.
  str(s, maxBytes = 64) {
    const bytes = ENC.encode(String(s ?? ""));
    const n = Math.min(bytes.length, maxBytes, U8_MAX);
    this.u8(n);
    this.ensure(n);
    this.buf.set(bytes.subarray(0, n), this.o);
    this.o += n;
    return this;
  }

  bytes() { return this.buf.subarray(0, this.o); }
  get length() { return this.o; }
}

export class Reader {
  constructor(source) {
    let ab, offset = 0, length;
    if (source instanceof ArrayBuffer) {
      ab = source; length = source.byteLength;
    } else if (ArrayBuffer.isView(source)) {
      ab = source.buffer; offset = source.byteOffset; length = source.byteLength;
    } else {
      throw new TypeError("Reader needs an ArrayBuffer or a view");
    }
    this.view = new DataView(ab, offset, length);
    this.len = length;
    this.o = 0;
  }

  get remaining() { return this.len - this.o; }

  need(n) {
    if (n < 0 || this.o + n > this.len) {
      throw new RangeError(`truncated frame: needed ${n}, have ${this.remaining}`);
    }
  }

  // Validate a decoded count before it is used to size a loop or an array.
  // This is the check that stops "count = 4 billion" from allocating.
  expect(count, bytesEach) {
    if (!Number.isInteger(count) || count < 0) throw new RangeError("bad count");
    if (bytesEach > 0 && count * bytesEach > this.remaining) {
      throw new RangeError(`count ${count} exceeds ${this.remaining} remaining bytes`);
    }
    return count;
  }

  u8() { this.need(1); const v = this.view.getUint8(this.o); this.o += 1; return v; }
  u16() { this.need(2); const v = this.view.getUint16(this.o, true); this.o += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.o, true); this.o += 4; return v; }
  i16() { this.need(2); const v = this.view.getInt16(this.o, true); this.o += 2; return v; }
  f32() { this.need(4); const v = this.view.getFloat32(this.o, true); this.o += 4; return v; }

  str() {
    const n = this.u8();
    this.need(n);
    const out = DEC.decode(new Uint8Array(this.view.buffer, this.view.byteOffset + this.o, n));
    this.o += n;
    return out;
  }

  // Callers use this to reject frames with trailing junk, which is a cheap
  // signal that a client is not speaking the protocol we think it is.
  end() {
    if (this.remaining !== 0) throw new RangeError(`${this.remaining} trailing bytes`);
  }
}

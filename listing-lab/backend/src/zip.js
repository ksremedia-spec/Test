/**
 * A ZIP file, streamed, from files we read one at a time.
 *
 * WHY THIS EXISTS (9 Sep 2026, Kyle: "group download from the My Photos
 * page"). An agent finishing a listing wants the whole set in one go, not
 * twenty taps. The results live in R2 as JPEGs, which do not compress, so the
 * archive stores them as-is ("store" method, no deflate) — the only work is
 * the framing and a checksum, and both can be done while the bytes flow past.
 *
 * Streaming matters: a set can be a couple of hundred megabytes, and the
 * Worker never holds more than one chunk of it. Sizes and checksums are not
 * known until a file has gone by, so each entry uses the "data descriptor"
 * form (general-purpose flag bit 3): the local header carries zeros, and the
 * real CRC and sizes follow the data. Every unzipper in use — the Files app,
 * Finder, Windows Explorer — reads this form; it is how large downloads have
 * shipped for years.
 *
 * Limits: plain (non-ZIP64) ZIP, so under 4 GB total and under 65,535 files.
 * A listing's worth of photos is nowhere near either.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Update(crc, bytes) {
  let c = crc ^ 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** MS-DOS time and date fields, as ZIP wants them. */
function dosTime(d) {
  const time = ((d.getUTCHours() & 31) << 11) | ((d.getUTCMinutes() & 63) << 5) | ((d.getUTCSeconds() >> 1) & 31);
  const date = (((d.getUTCFullYear() - 1980) & 127) << 9) | (((d.getUTCMonth() + 1) & 15) << 5) | (d.getUTCDate() & 31);
  return { time, date };
}

class Writer {
  constructor(size) { this.buf = new Uint8Array(size); this.view = new DataView(this.buf.buffer); this.pos = 0; }
  u16(v) { this.view.setUint16(this.pos, v, true); this.pos += 2; }
  u32(v) { this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  bytes(b) { this.buf.set(b, this.pos); this.pos += b.length; }
  done() { return this.buf.subarray(0, this.pos); }
}

const FLAGS = 0x0808;   // bit 3: sizes/CRC in the data descriptor; bit 11: names are UTF-8

function localHeader(nameBytes, t) {
  const w = new Writer(30 + nameBytes.length);
  w.u32(0x04034b50); w.u16(20); w.u16(FLAGS); w.u16(0);
  w.u16(t.time); w.u16(t.date);
  w.u32(0); w.u32(0); w.u32(0);          // crc, compressed, uncompressed — in the descriptor
  w.u16(nameBytes.length); w.u16(0);
  w.bytes(nameBytes);
  return w.done();
}

function dataDescriptor(crc, size) {
  const w = new Writer(16);
  w.u32(0x08074b50); w.u32(crc); w.u32(size); w.u32(size);
  return w.done();
}

function centralEntry(e) {
  const w = new Writer(46 + e.nameBytes.length);
  w.u32(0x02014b50); w.u16(20); w.u16(20); w.u16(FLAGS); w.u16(0);
  w.u16(e.t.time); w.u16(e.t.date);
  w.u32(e.crc); w.u32(e.size); w.u32(e.size);
  w.u16(e.nameBytes.length); w.u16(0); w.u16(0); w.u16(0); w.u16(0);
  w.u32(0); w.u32(e.offset);
  w.bytes(e.nameBytes);
  return w.done();
}

function endRecord(count, cdSize, cdOffset) {
  const w = new Writer(22);
  w.u32(0x06054b50); w.u16(0); w.u16(0); w.u16(count); w.u16(count);
  w.u32(cdSize); w.u32(cdOffset); w.u16(0);
  return w.done();
}

/**
 * Build the archive as a ReadableStream.
 *
 * `entries` is an array of `{ name, open }` where `open()` returns a
 * ReadableStream of the file's bytes (or null to skip that entry — a result
 * that vanished between the listing and the click is left out, not fatal).
 * Files are opened one at a time, only when their turn comes.
 */
export function zipStream(entries, now = new Date()) {
  const enc = new TextEncoder();
  const t = dosTime(now);
  const central = [];
  let offset = 0;

  // The whole archive is produced by one async loop writing into the
  // controller. `start` must not return that promise — it would hold back the
  // first bytes until the last file — so the loop is kicked off, not awaited.
  // Backpressure: a phone on a slow link pulls slowly, and the Worker must
  // not read R2 faster than the client drains — so the loop waits for `pull`
  // whenever the stream's queue is full, and R2 is read at the client's pace.
  let wake = null;
  return new ReadableStream({
    pull() { if (wake) { const w = wake; wake = null; w(); } },
    start(controller) {
      const push = async (chunk) => {
        while (controller.desiredSize !== null && controller.desiredSize <= 0) {
          await new Promise(r => { wake = r; });
        }
        controller.enqueue(chunk); offset += chunk.length;
      };
      (async () => {
        try {
          for (const entry of entries) {
            let body = await entry.open();
            if (!body) continue;
            // Bytes rather than a stream (a test double, a small buffer) are
            // wrapped so the loop below has one shape to deal with.
            if (typeof body.getReader !== 'function') body = new Blob([body]).stream();
            const nameBytes = enc.encode(entry.name);
            const localOffset = offset;
            await push(localHeader(nameBytes, t));

            let crc = 0, size = 0;
            const reader = body.getReader();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              crc = crc32Update(crc, value);
              size += value.length;
              await push(value);
            }
            await push(dataDescriptor(crc, size));
            central.push({ nameBytes, t, crc, size, offset: localOffset });
          }
          const cdOffset = offset;
          let cdSize = 0;
          for (const e of central) { const c = centralEntry(e); await push(c); cdSize += c.length; }
          await push(endRecord(central.length, cdSize, cdOffset));
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      })();
    },
  });
}

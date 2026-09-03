// ---------------------------------------------------------------------------
// Persistence.
//
// A deliberately small interface so the storage engine can be swapped without
// touching anything that uses it. FileStore is the implementation that ships.
//
// FILESTORE IS NOT PRODUCTION STORAGE. It is a JSON file, it holds everything
// in memory, and it has no transactions — two concurrent writes to related
// records can interleave and leave the file inconsistent. It exists so that
// accounts survive a process restart during development.
//
// On Render specifically the filesystem is EPHEMERAL: every deploy and every
// restart wipes it. Before this holds anything a person cares about, replace
// FileStore with Postgres. The interface below is the seam for that.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export class MemoryStore {
  constructor(seed = {}) { this.data = structuredClone(seed); }
  get(collection, id) { return this.data[collection]?.[id] ?? null; }
  all(collection) { return Object.values(this.data[collection] || {}); }
  put(collection, id, value) {
    (this.data[collection] ||= {})[id] = value;
    return value;
  }
  remove(collection, id) { delete this.data[collection]?.[id]; }
  async flush() {}
}

export class FileStore extends MemoryStore {
  constructor(file) {
    super();
    this.file = path.resolve(file);
    this.dirty = false;
    this.writing = null;
    this.load();
    // Debounced rather than written on every mutation: a login touches several
    // records, and the game loop must not stall on disk I/O.
    this.timer = setInterval(() => { if (this.dirty) this.flush(); }, 2000);
    this.timer.unref?.();
  }

  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") {
        // Refuse to start on a corrupt file rather than silently starting
        // empty, which would look exactly like every account being deleted.
        throw new Error(`Cannot read ${this.file}: ${err.message}`);
      }
      this.data = {};
    }
  }

  put(collection, id, value) {
    this.dirty = true;
    return super.put(collection, id, value);
  }

  remove(collection, id) {
    this.dirty = true;
    super.remove(collection, id);
  }

  // Write to a temporary file and rename over the original. rename is atomic
  // on POSIX, so a crash mid-write leaves the previous file intact rather
  // than a half-written one.
  async flush() {
    if (this.writing) return this.writing;
    this.dirty = false;
    const tmp = `${this.file}.${process.pid}.tmp`;
    this.writing = (async () => {
      try {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await fsp.writeFile(tmp, JSON.stringify(this.data), "utf8");
        await fsp.rename(tmp, this.file);
      } catch (err) {
        this.dirty = true;   // try again on the next sweep
        console.error("store flush failed:", err.message);
      } finally {
        this.writing = null;
      }
    })();
    return this.writing;
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}

export function createStore(file) {
  return file ? new FileStore(file) : new MemoryStore();
}

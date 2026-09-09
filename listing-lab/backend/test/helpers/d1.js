/**
 * A D1-shaped wrapper over node:sqlite, so the Worker's real queries run against
 * a real SQLite database with the real schema.sql in the tests.
 *
 * D1 IS SQLite, so this exercises the actual constraints — the UNIQUE keys that
 * stop a duplicate purchase, the CHECK that stops an unknown transformation, the
 * conditional UPDATE that arbitrates attempts. A hand-written fake would let all
 * of those pass by not existing.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }

  async first() {
    const rows = this.db.prepare(this.sql).all(...this.args);
    return rows.length ? rows[0] : null;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args), success: true };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    // D1 reports row counts under meta.changes; mirror that shape.
    return { success: true, meta: { changes: Number(info.changes ?? 0) } };
  }
}

export class TestD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(join(here, '..', '..', 'schema.sql'), 'utf8'));
  }
  prepare(sql) { return new Statement(this.db, sql); }
  /** D1's batch: the statements run in order inside one transaction. */
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}

/** Minimal execution context — waitUntil work is awaited so tests can assert on it. */
export function testCtx() {
  const pending = [];
  return {
    waitUntil: p => pending.push(Promise.resolve(p)),
    settled: () => Promise.all(pending),
  };
}

/**
 * An in-memory stand-in for an R2 bucket. Only the three methods the Worker uses.
 * Stores the bytes so a test can assert a result was actually written, not just
 * that a database row changed.
 */
export class TestR2 {
  constructor() { this.objects = new Map(); }
  async put(key, value, opts = {}) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value);
    this.objects.set(key, { bytes, httpMetadata: opts.httpMetadata || {} });
    return { key };
  }
  async get(key) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { body: o.bytes, httpMetadata: o.httpMetadata, arrayBuffer: async () => o.bytes.buffer };
  }
  async delete(key) {
    // R2 accepts one key or an array of up to 1000 (account deletion uses the array form).
    for (const k of Array.isArray(key) ? key : [key]) this.objects.delete(k);
  }
  /** R2's list, enough of it for a prefix walk: {objects:[{key}], truncated, cursor}. */
  async list({ prefix = '', cursor = null, limit = 1000 } = {}) {
    const keys = [...this.objects.keys()].filter(k => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return { objects: page.map(key => ({ key })), truncated, cursor: truncated ? String(start + limit) : undefined };
  }
}

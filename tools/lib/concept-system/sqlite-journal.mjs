import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { hash, stable, redact } from "./store.mjs";

const require = createRequire(import.meta.url);
const APPLICATION_ID = 0x42574353;
const ENTITY_KINDS = [
  "members",
  "collections",
  "sources",
  "decisions",
  "feedback",
];
const SCHEMA = `
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE events(
 seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, at TEXT NOT NULL,
 trace_id TEXT, decision_id TEXT, session_id TEXT, payload TEXT NOT NULL CHECK(json_valid(payload))
) STRICT;
CREATE INDEX events_trace_seq ON events(trace_id,seq);
CREATE INDEX events_decision_seq ON events(decision_id,seq);
CREATE INDEX events_session_seq ON events(session_id,seq);
CREATE INDEX events_type_seq ON events(type,seq);
CREATE INDEX events_at_seq ON events(at,seq);
CREATE TABLE versions(
 ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, hash TEXT,
 payload TEXT NOT NULL CHECK(json_valid(payload))
) STRICT;
CREATE INDEX versions_role_ordinal ON versions(role,ordinal);
CREATE TABLE receipts(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result))) STRICT;
CREATE TABLE previews(id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TABLE state_values(key TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
CREATE TABLE concept_entities(kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(kind,id)) STRICT;
`;
const json = (x) => JSON.stringify(x);
// Additive capability within schema 1; old read-only observers need no migration.
const LEARNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS learning_jobs(
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
 available_at INTEGER NOT NULL, lease_until INTEGER NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload))
) STRICT;
CREATE INDEX IF NOT EXISTS learning_jobs_ready ON learning_jobs(status,available_at);
CREATE INDEX IF NOT EXISTS learning_jobs_session ON learning_jobs(session_id,status);
CREATE TABLE IF NOT EXISTS video_reads(
 id TEXT PRIMARY KEY, bvid TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload))
) STRICT;
CREATE INDEX IF NOT EXISTS video_reads_seen ON video_reads(kind,status,bvid);
CREATE INDEX IF NOT EXISTS video_reads_session ON video_reads(json_extract(payload,'$.session_id'),status);
CREATE TABLE IF NOT EXISTS video_read_jobs(
 read_id TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(read_id,job_id)
) STRICT;
CREATE INDEX IF NOT EXISTS video_read_jobs_job ON video_read_jobs(job_id);
`;
function plain(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
function validateLegacy(d) {
  if (
    !plain(d) ||
    d.schema !== 1 ||
    !Number.isSafeInteger(d.seq) ||
    !Array.isArray(d.events) ||
    d.seq !== d.events.length ||
    !plain(d.state) ||
    !plain(d.versions) ||
    !plain(d.receipts) ||
    (d.previews !== undefined && !plain(d.previews))
  )
    throw Error("Invalid legacy journal schema");
  if (
    d.events.some(
      (e, i) =>
        !plain(e) ||
        e.seq !== i + 1 ||
        typeof e.id !== "string" ||
        typeof e.type !== "string" ||
        typeof e.at !== "string",
    )
  )
    throw Error("Invalid legacy event sequence");
  for (const [role, versions] of Object.entries(d.versions))
    if (
      !Array.isArray(versions) ||
      versions.some(
        (v) => !plain(v) || v.role !== role || typeof v.id !== "string",
      )
    )
      throw Error("Invalid legacy versions");
  for (const r of Object.values(d.receipts))
    if (!plain(r) || typeof r.fingerprint !== "string")
      throw Error("Invalid legacy receipt");
  return d;
}
function flatten(state) {
  const values = new Map(),
    entities = new Map();
  for (const [key, value] of Object.entries(state)) {
    if (key !== "concepts") {
      values.set(key, stable(value));
      continue;
    }
    if (!plain(value)) throw Error("Invalid concept state");
    const meta = Object.fromEntries(
      Object.entries(value).filter(([k]) => !ENTITY_KINDS.includes(k)),
    );
    values.set("concepts", stable(meta));
    for (const kind of ENTITY_KINDS) {
      if (!plain(value[kind]))
        throw Error("Invalid concept entity map: " + kind);
      for (const [id, entity] of Object.entries(value[kind]))
        entities.set(json([kind, id]), stable(entity));
    }
  }
  return { values, entities };
}
function readState(db) {
  const state = Object.fromEntries(
    db
      .prepare("SELECT key,payload FROM state_values")
      .all()
      .map((r) => [r.key, JSON.parse(r.payload)]),
  );
  if (state.concepts) {
    for (const kind of ENTITY_KINDS)
      state.concepts[kind] = Object.fromEntries(
        db
          .prepare("SELECT id,payload FROM concept_entities WHERE kind=?")
          .all(kind)
          .map((r) => [r.id, JSON.parse(r.payload)]),
      );
  }
  return state;
}
function saveState(db, before, state) {
  const after = flatten(state);
  const upsertValue = db.prepare(
      "INSERT INTO state_values VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
    ),
    deleteValue = db.prepare("DELETE FROM state_values WHERE key=?");
  const upsertEntity = db.prepare(
      "INSERT INTO concept_entities VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",
    ),
    deleteEntity = db.prepare(
      "DELETE FROM concept_entities WHERE kind=? AND id=?",
    );
  for (const [key, value] of after.values)
    if (before.values.get(key) !== value) upsertValue.run(key, value);
  for (const key of before.values.keys())
    if (!after.values.has(key)) deleteValue.run(key);
  for (const [key, value] of after.entities)
    if (before.entities.get(key) !== value)
      upsertEntity.run(...JSON.parse(key), value);
  for (const key of before.entities.keys())
    if (!after.entities.has(key)) deleteEntity.run(...JSON.parse(key));
}
function insertEvent(db, e) {
  db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)").run(
    e.seq,
    e.id,
    e.type,
    e.at,
    e.trace_id ?? null,
    e.decision_id ?? null,
    e.session_id ?? null,
    json(e),
  );
}
function addVersion(db, v) {
  db.prepare("INSERT INTO versions(id,role,hash,payload) VALUES(?,?,?,?)").run(
    v.id,
    v.role,
    v.hash ?? null,
    json(v),
  );
}
function assertRegular(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("SQLite or legacy path must be a regular file");
}

export class SqliteJournal {
  constructor(store) {
    this.store = store;
  }
  open() {
    let db;
    try {
      let DatabaseSync;
      try {
        ({ DatabaseSync } = require("node:sqlite"));
      } catch {
        throw Error(
          "Concept SQLite storage requires Node 22.13+ with node:sqlite; ordinary plugin features can remain disabled for observation",
        );
      }
      fs.mkdirSync(this.store.directory, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(this.store.directory).isSymbolicLink())
        throw Error("Observation directory must not be a symlink");
      fs.chmodSync(this.store.directory, 0o700);
      for (const suffix of ["", "-wal", "-shm", "-journal"])
        assertRegular(this.store.file + suffix);
      try {
        fs.closeSync(fs.openSync(this.store.file, "wx", 0o600));
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      fs.chmodSync(this.store.file, 0o600);
      db = new DatabaseSync(this.store.file);
      db.exec(
        "PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;",
      );
      // Both header values must come from one read snapshot while another process initializes.
      db.exec("BEGIN");
      const version = db.prepare("PRAGMA user_version").get().user_version,
        app = db.prepare("PRAGMA application_id").get().application_id;
      db.exec("COMMIT");
      if (version === 0 && app === 0) {
        db.exec(
          "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;",
        );
        try {
          // Another process may have initialized while this connection waited for the writer lock.
          const lockedVersion = db
            .prepare("PRAGMA user_version")
            .get().user_version;
          if (lockedVersion === 0) {
            if (
              db.prepare("PRAGMA application_id").get().application_id !== 0 ||
              db
                .prepare(
                  "SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
                )
                .get().n
            )
              throw Error(
                "Refusing to initialize an unrelated SQLite database",
              );
            db.exec(SCHEMA);
            this.importLegacy(db);
            db.exec(
              `PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;`,
            );
          } else if (
            lockedVersion !== 1 ||
            db.prepare("PRAGMA application_id").get().application_id !==
              APPLICATION_ID
          )
            throw Error("Unsupported SQLite schema");
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      } else if (version !== 1 || app !== APPLICATION_ID)
        throw Error("Unsupported SQLite schema or application ID");
      db.exec("PRAGMA synchronous=FULL;");
      db.exec(LEARNING_SCHEMA);
      return db;
    } catch (e) {
      try {
        db?.close();
      } catch {}
      throw Error(
        "Observation SQLite unavailable; refusing update: " + e.message,
      );
    }
  }
  importLegacy(db) {
    if (!fs.existsSync(this.store.legacyFile)) return;
    assertRegular(this.store.legacyFile);
    const raw = fs.readFileSync(this.store.legacyFile, "utf8"),
      d = validateLegacy(JSON.parse(raw));
    for (const versions of Object.values(d.versions))
      for (const v of versions) if (v.hash) this.store.getObject(v.hash);
    for (const p of Object.values(d.previews ?? {})) {
      if (
        !plain(p) ||
        typeof p.object !== "string" ||
        typeof p.state_object !== "string"
      )
        throw Error("Invalid legacy preview");
      this.store.getObject(p.object);
      this.store.getObject(p.state_object);
    }
    for (const e of d.events) insertEvent(db, e);
    for (const versions of Object.values(d.versions))
      for (const v of versions) addVersion(db, v);
    for (const [key, r] of Object.entries(d.receipts))
      db.prepare("INSERT INTO receipts VALUES(?,?,?)").run(
        key,
        r.fingerprint,
        json({ value: r.result }),
      );
    for (const [id, p] of Object.entries(d.previews ?? {}))
      db.prepare("INSERT INTO previews VALUES(?,?)").run(id, json(p));
    saveState(db, { values: new Map(), entities: new Map() }, d.state);
    db.prepare("INSERT INTO metadata VALUES(?,?)").run(
      "legacy_import",
      json({
        hash: hash(raw),
        events: d.seq,
        file: "journal.json",
        imported_at: new Date(this.store.now()).toISOString(),
      }),
    );
  }
  use(fn) {
    const db = this.open();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }
  state() {
    return this.use((db) => {
      db.exec("BEGIN");
      try {
        const state = readState(db);
        db.exec("COMMIT");
        return state;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    });
  }
  preview(id) {
    return this.use((db) => {
      const r = db.prepare("SELECT payload FROM previews WHERE id=?").get(id);
      return r ? JSON.parse(r.payload) : null;
    });
  }
  status() {
    return this.use((db) => ({
      schema: 1,
      backend: "sqlite",
      events: db.prepare("SELECT count(*) AS n FROM events").get().n,
      roles: db
        .prepare("SELECT DISTINCT role FROM versions")
        .all()
        .map((r) => r.role),
      directory: this.store.directory,
      file: this.store.file,
      migration: JSON.parse(
        db.prepare("SELECT value FROM metadata WHERE key='legacy_import'").get()
          ?.value ?? "null",
      ),
    }));
  }
  integrity() {
    return this.use((db) => db.prepare("PRAGMA quick_check").all());
  }
  export() {
    return this.use((db) => {
      db.exec("BEGIN");
      try {
        const events = db
            .prepare("SELECT payload FROM events ORDER BY seq")
            .all()
            .map((r) => JSON.parse(r.payload)),
          versions = {};
        for (const r of db
          .prepare("SELECT role,payload FROM versions ORDER BY ordinal")
          .all())
          (versions[r.role] ??= []).push(JSON.parse(r.payload));
        const d = {
          schema: 1,
          seq: events.at(-1)?.seq ?? 0,
          events,
          versions,
          state: readState(db),
          receipts: Object.fromEntries(
            db
              .prepare("SELECT * FROM receipts")
              .all()
              .map((r) => [
                r.key,
                {
                  fingerprint: r.fingerprint,
                  result: JSON.parse(r.result).value,
                },
              ]),
          ),
          previews: Object.fromEntries(
            db
              .prepare("SELECT * FROM previews")
              .all()
              .map((r) => [r.id, JSON.parse(r.payload)]),
          ),
        };
        db.exec("COMMIT");
        return d;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    });
  }
  transaction({ key, input, state: loadState = true } = {}, fn) {
    return this.use((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const fingerprint = hash(redact(input ?? null)),
          receipt = key
            ? db
                .prepare("SELECT fingerprint,result FROM receipts WHERE key=?")
                .get(key)
            : null;
        if (receipt) {
          if (receipt.fingerprint !== fingerprint)
            throw Error("Idempotency key reused with different input");
          db.exec("COMMIT");
          return JSON.parse(receipt.result).value;
        }
        const state = loadState ? readState(db) : undefined,
          before = loadState ? flatten(state) : null;
        const d = {
          receipt: key => {
            const r=db.prepare("SELECT result FROM receipts WHERE key=?").get(key);
            return r?JSON.parse(r.result).value:null;
          },
          reads: {
            get: id => {
              const r=db.prepare("SELECT payload FROM video_reads WHERE id=?").get(id);
              return r?JSON.parse(r.payload):null;
            },
            put: r => db.prepare("INSERT INTO video_reads VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,status=excluded.status,payload=excluded.payload")
              .run(r.id,r.bvid,r.kind,r.status,json(redact(r))),
            bindJob: (readId,jobId) => db.prepare("INSERT OR IGNORE INTO video_read_jobs VALUES(?,?)").run(readId,jobId),
            jobs: readId => db.prepare("SELECT j.payload FROM learning_jobs j JOIN video_read_jobs v ON v.job_id=j.id WHERE v.read_id=? ORDER BY j.id").all(readId).map(r=>JSON.parse(r.payload)),
            forJob: jobId => db.prepare("SELECT r.payload FROM video_reads r JOIN video_read_jobs v ON v.read_id=r.id WHERE v.job_id=?").all(jobId).map(r=>JSON.parse(r.payload)),
            awaiting: sessionId => db.prepare("SELECT payload FROM video_reads WHERE status='presented' AND json_extract(payload,'$.session_id')=? AND json_extract(payload,'$.learning_queued') IS NOT 1 AND kind!='none' LIMIT 24").all(sessionId).map(r=>JSON.parse(r.payload)),
          },
          jobs: {
            get: (id) => {
              const row = db.prepare("SELECT payload FROM learning_jobs WHERE id=?").get(id);
              return row ? JSON.parse(row.payload) : null;
            },
            list: (sessionId = null) => db.prepare(
              "SELECT payload FROM learning_jobs WHERE (? IS NULL OR session_id=?) AND status NOT IN ('done','failed') ORDER BY rowid",
            ).all(sessionId, sessionId).map(r => JSON.parse(r.payload)),
            put: (job) => db.prepare(
              "INSERT INTO learning_jobs VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,available_at=excluded.available_at,lease_until=excluded.lease_until,payload=excluded.payload",
            ).run(job.id,job.session_id,job.status,job.available_at,job.lease_until,json(redact(job))),
          },
          state,
          seq: db
            .prepare("SELECT coalesce(max(seq),0) AS seq FROM events")
            .get().seq,
          latestVersion: (role) => {
            const r = db
              .prepare(
                "SELECT payload FROM versions WHERE role=? ORDER BY ordinal DESC LIMIT 1",
              )
              .get(role);
            return r ? JSON.parse(r.payload) : null;
          },
          addVersion: (v) => addVersion(db, v),
          preview: (id) => {
            const r = db
              .prepare("SELECT payload FROM previews WHERE id=?")
              .get(id);
            return r ? JSON.parse(r.payload) : null;
          },
          savePreview: (id, value) =>
            db
              .prepare(
                "INSERT INTO previews VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
              )
              .run(id, json(value)),
        };
        const emit = (type, data = {}, links = {}) => {
          const e = {
            ...redact(links),
            id: crypto.randomUUID(),
            seq: ++d.seq,
            type,
            at: new Date(this.store.now()).toISOString(),
            timezone: "Asia/Shanghai",
            data: redact(data),
          };
          insertEvent(db, e);
          return e;
        };
        const result = fn(d, emit);
        if (result && typeof result.then === "function")
          throw Error("SQLite transaction callback must be synchronous");
        if (loadState) saveState(db, before, d.state);
        if (key)
          db.prepare("INSERT INTO receipts VALUES(?,?,?)").run(
            key,
            fingerprint,
            json({ value: result }),
          );
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    });
  }
  events({
    trace_id,
    decision_id,
    session_id,
    type,
    after = 0,
    limit = 100,
    since,
    until,
  } = {}) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw Error("Invalid event cursor or limit");
    return this.use((db) => {
      const conditions = ["seq>?"],
        args = [after];
      for (const [column, value] of Object.entries({
        trace_id,
        decision_id,
        session_id,
        type,
      })) {
        if (value) {
          conditions.push(column + "=?");
          args.push(value);
        }
      }
      if (since) {
        conditions.push("at>=?");
        args.push(since);
      }
      if (until) {
        conditions.push("at<=?");
        args.push(until);
      }
      args.push(limit);
      return db
        .prepare(
          `SELECT payload FROM events WHERE ${conditions.join(" AND ")} ORDER BY seq LIMIT ?`,
        )
        .all(...args)
        .map((r) => JSON.parse(r.payload));
    });
  }
  version(role, id) {
    return this.use((db) => {
      const r = db
        .prepare("SELECT payload FROM versions WHERE role=? AND id=?")
        .get(role, id);
      return r ? JSON.parse(r.payload) : null;
    });
  }
  versions(role) {
    return this.use((db) =>
      db
        .prepare("SELECT payload FROM versions WHERE role=? ORDER BY ordinal")
        .all(role)
        .map((r) => JSON.parse(r.payload)),
    );
  }
}

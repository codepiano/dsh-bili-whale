import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { ObservationStore, hash } from "../tools/lib/concept-system/store.mjs";
import { ConceptEngine } from "../tools/lib/concept-system/engine.mjs";
const moduleURL = new URL(
  "../tools/lib/concept-system/store.mjs",
  import.meta.url,
).href;
function box(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whale-sqlite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function child(code, args = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      ["--input-type=module", "-e", code, ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    p.stdout.on("data", (x) => (out += x));
    p.stderr.on("data", (x) => (err += x));
    p.once("error", reject);
    p.once("exit", (code, signal) =>
      code === 0 ? resolve(out) : reject(Error(err || signal || code)),
    );
  });
}
test("legacy journal migrates atomically once, retaining events, versions, receipts, previews and snapshot bytes", async (t) => {
  const root = box(t),
    store = new ObservationStore(root),
    obj = store.object("original persona"),
    stateObj = store.object({ state: "preview" });
  const version = {
    id: "v1",
    role: "persona",
    status: "present",
    hash: obj.hash,
    actor: "old",
    at: "2026-10-27T00:00:00.000Z",
  };
  const event = {
    seq: 1,
    id: "e1",
    type: "before",
    at: "2026-10-27T00:00:00.000Z",
    data: { object: obj },
    trace_id: "t",
  };
  const legacy = {
    schema: 1,
    seq: 1,
    events: [event],
    versions: { persona: [version] },
    receipts: {
      existing: { fingerprint: hash({ hello: 1 }), result: { saved: true } },
    },
    state: { counter: 4 },
    previews: {
      p1: { object: obj.hash, state_object: stateObj.hash, committed: null },
    },
  };
  const original = JSON.stringify(legacy);
  fs.writeFileSync(store.legacyFile, original);
  assert.deepEqual(store.read(), legacy);
  assert.equal(store.status().migration.events, 1);
  assert.deepEqual(
    await store.transaction({ key: "existing", input: { hello: 1 } }, () =>
      assert.fail("must not replay receipt"),
    ),
    { saved: true },
  );
  assert.equal(store.getObject(obj.hash).content, "original persona");
  assert.equal(fs.readFileSync(store.legacyFile, "utf8"), original);
  await store.event("after", {}, { trace_id: "t" });
  assert.deepEqual(
    new ObservationStore(root).events({ trace_id: "t" }).map((e) => e.seq),
    [1, 2],
  );
  assert.equal(new ObservationStore(root).status().events, 2);
  const db = new DatabaseSync(store.file);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  db.close();
});
test("invalid migration and missing object stop without partially importing or deleting originals", async (t) => {
  const root = box(t),
    store = new ObservationStore(root),
    bad = {
      schema: 1,
      seq: 1,
      events: [{ id: "e", seq: 2, type: "bad", at: "now" }],
      versions: {},
      receipts: {},
      state: {},
    };
  fs.writeFileSync(store.legacyFile, JSON.stringify(bad));
  assert.throws(() => store.read(), /legacy event sequence/);
  const db = new DatabaseSync(store.file);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'")
      .get().n,
    0,
  );
  db.close();
  bad.events[0].seq = 1;
  bad.versions = {
    persona: [{ id: "v", role: "persona", hash: "a".repeat(64) }],
  };
  fs.writeFileSync(store.legacyFile, JSON.stringify(bad));
  assert.throws(() => store.read(), /refusing update/);
  assert.equal(JSON.parse(fs.readFileSync(store.legacyFile)).seq, 1);
});
test("SQLite normalizes learning entities and updates only changed rows, while event-only writes skip state", async (t) => {
  const store = new ObservationStore(box(t)),
    engine = new ConceptEngine(store);
  await engine.call("concept_propose", {
    key: "p",
    subject: "fish",
    source: {
      id: "s",
      actor: "user",
      type: "conversation",
      excerpt: "想了解康德",
    },
    content: "康德",
    tags: ["topic"],
  });
  const db = new DatabaseSync(store.file);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM concept_entities WHERE kind='members'",
      )
      .get().n,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM concept_entities WHERE kind='sources'",
      )
      .get().n,
    1,
  );
  assert.equal(
    JSON.parse(
      db.prepare("SELECT payload FROM state_values WHERE key='concepts'").get()
        .payload,
    ).members,
    undefined,
  );
  db.exec(
    "CREATE TRIGGER no_entity_rewrite BEFORE UPDATE ON concept_entities BEGIN SELECT RAISE(ABORT,'unchanged entity rewrite'); END;",
  );
  db.close();
  await store.event("only.event");
  await store.transaction({}, () => ({ ok: true }));
  assert.equal(store.events({ type: "only.event" }).length, 1);
});
test("concurrent real processes initialize, append and enforce cross-process idempotency without port locks", async (t) => {
  const root = box(t);
  const code = `import { ObservationStore } from ${JSON.stringify(moduleURL)};const s=new ObservationStore(process.argv[1]);for(let i=0;i<10;i++)await s.transaction({key:'worker-'+process.argv[2]+'-'+i,input:i},(d,emit)=>{d.state.count=(d.state.count??0)+1;return emit('concurrent',{}, {trace_id:'shared'})});await s.transaction({key:'shared',input:1},(d,emit)=>{d.state.shared=(d.state.shared??0)+1;return emit('once')});`;
  await Promise.all(
    Array.from({ length: 5 }, (_, i) => child(code, [root, String(i)])),
  );
  const s = new ObservationStore(root);
  assert.equal(s.state().count, 50);
  assert.equal(s.state().shared, 1);
  assert.equal(s.status().events, 51);
  assert.deepEqual(
    s.events({ limit: 100 }).map((e) => e.seq),
    Array.from({ length: 51 }, (_, i) => i + 1),
  );
});
test("killed writer rolls back its uncommitted event and state, and the next writer can continue", async (t) => {
  const root = box(t),
    s = new ObservationStore(root);
  await s.transaction({}, (d, emit) => {
    d.state.count = 1;
    emit("initial");
  });
  const code = `import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1]);d.exec('BEGIN IMMEDIATE');d.prepare('UPDATE state_values SET payload=? WHERE key=?').run('999','count');d.prepare('INSERT INTO events VALUES(2,?,?,?,?,?,?,?)').run('dead','dead','now',null,null,null,JSON.stringify({seq:2,type:'dead'}));process.kill(process.pid,'SIGKILL');`;
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code, s.file],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(r.signal, "SIGKILL");
  assert.equal(s.state().count, 1);
  assert.equal(s.events().length, 1);
  await s.event("recovered");
  assert.equal(s.events().at(-1).seq, 2);
  assert.deepEqual(
    s.integrity().map((r) => r.quick_check),
    ["ok"],
  );
});
test("indexed SQL pagination and version diff do not need a whole-journal export", async (t) => {
  const s = new ObservationStore(box(t));
  await s.transaction({ state: false }, (_, emit) => {
    for (let i = 0; i < 2000; i++)
      emit(
        i % 2 ? "odd" : "even",
        { i },
        { trace_id: i % 3 ? "other" : "target" },
      );
  });
  const a = await s.snapshot("persona", "a"),
    b = await s.snapshot("persona", "b");
  s.read = () => assert.fail("whole-journal export is not a hot path");
  const events = s.events({
    trace_id: "target",
    type: "even",
    after: 900,
    limit: 7,
  });
  assert.equal(events.length, 7);
  assert.ok(
    events.every(
      (e) => e.seq > 900 && e.type === "even" && e.trace_id === "target",
    ),
  );
  assert.equal(s.diff("persona", a.id, b.id).after.content, "b");
  const db = new DatabaseSync(s.file);
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT payload FROM events WHERE trace_id=? AND seq>? ORDER BY seq LIMIT ?",
    )
    .all("target", 900, 7);
  assert.match(JSON.stringify(plan), /events_trace_seq/);
  db.close();
});
test("corrupt and foreign databases are rejected, not reset; SQLite files are private", async (t) => {
  const root = box(t),
    s = new ObservationStore(root);
  fs.writeFileSync(s.file, "corrupt");
  assert.throws(() => s.status(), /refusing update/);
  assert.equal(fs.readFileSync(s.file, "utf8"), "corrupt");
  fs.rmSync(s.file);
  const db = new DatabaseSync(s.file);
  db.exec("CREATE TABLE unrelated(value TEXT);");
  db.close();
  assert.throws(() => s.status(), /unrelated/);
  fs.rmSync(s.file);
  s.status();
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
});
test("migration preserves a complete concept graph, pending decisions, replay and subsequent commit", async (t) => {
  const original = new ObservationStore(box(t)),
    engine = new ConceptEngine(original);
  const m = await engine.call("concept_propose", {
    key: "p",
    subject: "fish",
    source: {
      id: "s",
      actor: "user",
      type: "conversation",
      excerpt: "想了解康德",
    },
    content: "康德",
    tags: ["topic"],
  });
  const review = await engine.call("concept_review", {
    key: "r",
    candidate_id: m.id,
    status: "accepted",
    reason: "明确兴趣",
    collections: [{ name: "哲学" }],
  });
  const preview = await engine.call("decision_preview", {
    question: "先看什么",
    scene: "watch",
    seed: "migration",
    options: [
      {
        label: "学习",
        reason: "继续探索",
        contributions: [
          {
            collection_id: review.collection_ids[0],
            member_id: m.id,
            relevance: 1,
            strength: 1,
            reason: "明确兴趣",
          },
        ],
      },
      { label: "休息", reason: "也可休息", contributions: [] },
    ],
  });
  const legacy = original.read(),
    root = box(t);
  fs.cpSync(
    path.join(original.directory, "objects"),
    path.join(root, "objects"),
    { recursive: true },
  );
  fs.writeFileSync(path.join(root, "journal.json"), JSON.stringify(legacy));
  const migrated = new ObservationStore(root),
    next = new ConceptEngine(migrated);
  assert.deepEqual(migrated.state(), legacy.state);
  assert.equal(
    (await next.call("decision_replay", { preview_id: preview.preview_id }))
      .matches,
    true,
  );
  const result = await next.call("decision_commit", {
    key: "commit",
    preview_id: preview.preview_id,
    reason: "采用迁移前的建议",
  });
  assert.equal(result.selected, "学习");
  assert.ok(
    migrated.versions("concept_state").length >
      legacy.versions.concept_state.length,
  );
  assert.equal(
    (await next.call("decision_replay", { preview_id: preview.preview_id }))
      .matches,
    true,
  );
});

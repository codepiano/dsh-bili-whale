import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { observerFixture } from "./helpers/observer-fixture.mjs";
import { startObserverServer } from "../tools/lib/observer-server.mjs";
import { ObserverReader } from "../tools/lib/concept-system/observer-read.mjs";
import { hash } from "../tools/lib/concept-system/store.mjs";
import { lineChanges } from "../tools/observer-ui/src/diff.mjs";
function box(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whale-page-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function start(t, directory) {
  const assets = path.join(box(t), "assets");
  fs.mkdirSync(assets);
  for (const [name, text] of Object.entries({
    "index.html": "<!doctype html><title>观察室</title>",
    "app.js": 'console.log("test")',
    "app.css": "body{}",
  }))
    fs.writeFileSync(path.join(assets, name), text);
  const s = await startObserverServer({ directory, assetDirectory: assets });
  t.after(() => s.close());
  return s;
}
test("read-only reader serves concepts, historical decisions, feedback, versions and evidence without changing data", async (t) => {
  const root = box(t),
    f = await observerFixture(root),
    before = f.store.read(),
    reader = new ObserverReader(root);
  assert.equal(reader.overview().counts.collections, 4);
  assert.equal(reader.collections({ subject: "user" }).items.length, 1);
  assert.equal(
    reader.collections({ query: "表达" }).items[0].name,
    "表达与惯用句式",
  );
  assert.equal(reader.collection(f.a.group).items[0].source.actor, "user");
  assert.equal(
    reader.decisions({ stage: "pending" }).items[0].id,
    f.pending.preview_id,
  );
  const detail = reader.decision(f.preview.preview_id);
  assert.equal(detail.committed.overridden, true);
  assert.equal(detail.feedback[0].outcome, "positive");
  assert.equal(detail.names[f.a.group], "哲学与概念辨析");
  assert.equal(
    reader
      .diff("persona", f.old.id, f.newer.id)
      .after.content.includes("不确定"),
    true,
  );
  assert.ok(
    reader
      .events({ trace_id: f.trace.trace_id })
      .items.some((e) => e.type === "response.completed"),
  );
  assert.throws(() => reader.use(db => db.exec("DELETE FROM events")), /readonly|read-only/i);
  assert.deepEqual(f.store.read(), before);
});
test("page API is loopback-only, same-origin and read-only; values are parameters, never SQL", async (t) => {
  const root = box(t),
    f = await observerFixture(root),
    before = f.store.read(),
    s = await start(t, root);
  const get = async (url) => {
    const r = await fetch(s.url + url);
    assert.equal(r.status, 200);
    return r.json();
  };
  assert.equal((await get("/api/overview")).counts.previews, 2);
  assert.equal(
    (await get("/api/collections?query=" + encodeURIComponent("' OR 1=1 --")))
      .total,
    0,
  );
  assert.equal(
    (await get("/api/decisions/" + f.preview.preview_id)).preview.winner,
    "继续学习",
  );
  assert.equal(
    (await get("/api/versions?role=persona&limit=1")).items.length,
    1,
  );
  assert.equal(
    (
      await get(
        "/api/diff?" +
          new URLSearchParams({
            role: "persona",
            from: f.old.id,
            to: f.newer.id,
          }),
      )
    ).before.content.includes("短句优先"),
    true,
  );
  for (const [url, status] of [
    ["/api/collections?limit=-1", 400],
    ["/api/decisions?stage=invalid", 400],
    ["/api/decisions/missing", 404],
    ["/api/evidence/../../credentials.json", 404],
    ["/api/evidence/not-a-hash", 400],
    ["/api/nope", 404],
  ]) {
    const r = await fetch(s.url + url);
    assert.equal(r.status, status, url);
  }
  assert.equal(
    (await fetch(s.url + "/api/overview", { method: "POST", body: "{}" }))
      .status,
    405,
  );
  assert.equal(
    (
      await fetch(s.url + "/api/overview", {
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  const foreign = await new Promise((resolve, reject) => {
    http
      .get(
        s.url + "/api/overview",
        { headers: { host: "attacker.example" } },
        (r) => {
          r.resume();
          r.on("end", () => resolve(r.statusCode));
        },
      )
      .on("error", reject);
  });
  assert.equal(foreign, 403);
  const html = await fetch(s.url);
  assert.match(
    html.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal(html.headers.get("cache-control"), "no-store");
  assert.deepEqual(f.store.read(), before);
});
test("missing database stays absent; legacy logs are reported without auto-migration", async (t) => {
  const root = box(t),
    directory = path.join(root, "not-created"),
    s = await start(t, directory);
  const r = await fetch(s.url + "/api/overview");
  assert.equal((await r.json()).available, false);
  assert.equal(fs.existsSync(directory), false);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "journal.json"), "{}");
  const legacy = await fetch(s.url + "/api/overview");
  assert.equal((await legacy.json()).legacy, true);
  assert.equal(
    fs.existsSync(path.join(directory, "observations.sqlite3")),
    false,
  );
});
test("historical names do not change with live graph; missing snapshots have explicit errors", async (t) => {
  const root = box(t),
    f = await observerFixture(root),
    reader = new ObserverReader(root);
  await f.store.transaction({}, (d) => {
    d.state.concepts.collections[f.a.group].name = "后来的名称";
  });
  assert.equal(
    reader.decision(f.preview.preview_id).names[f.a.group],
    "哲学与概念辨析",
  );
  const p = f.store.preview(f.preview.preview_id);
  fs.rmSync(path.join(root, "objects", p.object + ".json"));
  assert.equal(
    reader.decisions().items.find((p) => p.id === f.preview.preview_id)
      .unavailable,
    true,
  );
  assert.throws(() => reader.decision(f.preview.preview_id), /快照不可用/);
});
test("versions and decisions have stable cursors; corrupt database errors do not reset it", async (t) => {
  const root = box(t),
    f = await observerFixture(root),
    reader = new ObserverReader(root);
  const a = reader.versions("persona", { limit: 1 }),
    b = reader.versions("persona", { limit: 1, before: a.next });
  assert.notEqual(a.items[0].id, b.items[0].id);
  const p = reader.decisions({ limit: 1 }),
    q = reader.decisions({ limit: 1, before: p.next });
  assert.notEqual(p.items[0].id, q.items[0].id);
  fs.writeFileSync(f.store.file, "broken database");
  const before = hash(fs.readFileSync(f.store.file));
  assert.throws(() => reader.overview());
  assert.equal(hash(fs.readFileSync(f.store.file)), before);
});
test("line diff handles additions, removals, unchanged text, JSON and large content fallback", () => {
  const d = lineChanges("old\nkeep\n", "new\nkeep\n");
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.ok(d.lines.some((l) => l.text === "keep" && l.kind === "same"));
  assert.equal(lineChanges("same", "same").added, 0);
  assert.equal(lineChanges(null, { a: 1 }).added, 3);
  assert.equal(lineChanges("x".repeat(400001), "").limited, true);
});

import { indexDiary } from "../tools/lib/diary-index.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { observerFixture } from "./helpers/observer-fixture.mjs";
import { startObserverServer } from "../tools/lib/observer-server.mjs";
import { ObserverReader } from "../tools/lib/concept-system/observer-read.mjs";
import { feedGroups } from "../tools/lib/concept-system/feed.mjs";
import { stanceMembers } from "../tools/lib/concept-system/feed-judgment.mjs";
import { ConceptEngine } from "../tools/lib/concept-system/engine.mjs";
import { hash } from "../tools/lib/concept-system/store.mjs";
import { lineChanges } from "../tools/observer-ui/src/diff.mjs";
function box(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whale-page-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function start(t, directory, logDirectory = directory) {
  const assets = path.join(box(t), "assets");
  fs.mkdirSync(assets);
  for (const [name, text] of Object.entries({
    "index.html": "<!doctype html><title>观察室</title>",
    "app.js": 'console.log("test")',
    "app.css": "body{}",
  }))
    fs.writeFileSync(path.join(assets, name), text);
  const s = await startObserverServer({ directory, logDirectory, assetDirectory: assets });
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

test('archived empty groups stay out of the active catalog and page but retain detail and can be reused',async t=>{
  const root=box(t),f=await observerFixture(root),reader=new ObserverReader(root),engine=new ConceptEngine(f.store)
  const before=reader.overview().counts.collections,c=reader.collection(f.a.group),member=c.items[0]
  await f.store.transaction({},d=>{const c=d.state.concepts.collections[f.a.group];c.archived_at=1;c.archive_reason='reviewed cleanup'})
  assert.equal(reader.overview().counts.collections,before-1)
  assert.ok(!feedGroups(f.store.state().concepts).some(g=>g.collection.id===f.a.group))
  assert.ok(!stanceMembers(f.store.state().concepts).some(g=>g.collection.id===f.a.group))
  assert.ok(!(await engine.call('personal_render',{subject:member.subject,scene:'general',budget:2000})).selected.includes(member.id))
  assert.ok(!reader.collections().items.some(c=>c.id===f.a.group))
  assert.ok(!(await engine.call('concept_catalog')).items.some(c=>c.id===f.a.group))
  assert.equal(reader.collection(f.a.group).archive_reason,'reviewed cleanup')
  await engine.call('concept_review',{key:'revive',candidate_id:member.id,status:'accepted',reason:'真实新归属',collections:[{collection_id:f.a.group}]})
  assert.equal(reader.overview().counts.collections,before)
  assert.ok(reader.collections().items.some(c=>c.id===f.a.group))
})

test("fish logs read live diary files and page activity without an observation database", async (t) => {
  const root = box(t);
  const logs = box(t);
  const server = await start(t, root, logs);
  const get = async (url) => {
    const response = await fetch(server.url + "/api/logs/" + url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.json();
  };
  assert.deepEqual(await get("diary"), { diary: null });
  assert.deepEqual(await get("activity"), { items: [], total: 0, page: 1, pages: 1, skipped: 0 });

  const diary = path.join(logs, "whale-diary.md");
  const privateDiary = path.join(logs, "whale-diary-private.md");
  const activity = path.join(logs, "whale-log.jsonl");
  fs.writeFileSync(diary, "## 公开日记");
  fs.writeFileSync(privateDiary, "## 私人日记");
  const event = (kind, at = "2026-11-22T19:00:00.000Z") =>
    JSON.stringify({ kind, at, target: "BVtest", note: "第一行\n第二行", extra: "ignored" });
  const originalLog = [event("watch"), "", "{broken", event("night", "bad time"), event("read")].join("\r\n");
  fs.writeFileSync(activity, originalLog);
  assert.equal((await get("diary")).diary.content, "## 公开日记");
  assert.equal((await get("diary?kind=private")).diary.content, "## 私人日记");
  const recent = await get("activity?limit=1");
  assert.deepEqual(recent, {
    items: [{ kind: "read", at: "2026-11-22T19:00:00.000Z", target: "BVtest", note: "第一行\n第二行" }],
    total: 2,
    page: 1,
    pages: 2,
    skipped: 2,
  });
  assert.equal((await get("activity?limit=1&page=2")).items[0].kind, "watch");
  fs.appendFileSync(diary, "\n新正文");
  assert.equal((await get("diary")).diary.content, "## 公开日记\n新正文");
  assert.equal(fs.readFileSync(activity, "utf8"), originalLog);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal((await fetch(server.url + "/api/logs/diary?kind=../credentials")).status, 400);
  assert.equal((await fetch(server.url + "/api/logs/diary?kind=private", {
    headers: { "Sec-Fetch-Site": "same-site" },
  })).status, 403);
});

test("timeline groups and filters by Beijing date before pagination", async (t) => {
  const root = box(t);
  const server = await start(t, root);
  const events = [
    { at: "2026-11-23T16:03:00Z", kind: "watch", target: "BV123", note: "最新" },
    { at: "2026-11-23T15:59:00Z", kind: "watch", target: "BV123", note: "昨天" },
    { at: "2026-11-23T17:00:00Z", kind: "share", target: null, note: "分享" },
    { at: "2026-11-23T16:01:00Z", kind: "watch", target: "BV123", note: "较早" },
  ];
  fs.writeFileSync(path.join(root, "whale-log.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
  const get = async (parameters) => {
    const query = new URLSearchParams({ view: "timeline", ...parameters });
    const response = await fetch(server.url + "/api/logs/activity?" + query);
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await get({ day: "2026-11-24", kind: "watch", query: " bv123 ", limit: 1 });
  assert.deepEqual(first.items, [{ ...events[0], day: "2026-11-24" }]);
  assert.deepEqual(first.days, ["2026-11-24", "2026-11-23"]);
  assert.deepEqual(first.kinds, ["share", "watch"]);
  assert.equal(first.total, 2);
  assert.equal(first.pages, 2);
  const second = await get({ day: "2026-11-24", kind: "watch", limit: 1, page: 2 });
  assert.deepEqual(second.items, [{ ...events[3], day: "2026-11-24" }]);
  assert.equal((await get({ query: "昨天", day: "2026-11-24" })).total, 0);
});

test("dated diary index preserves duplicate dates, fenced text and undated entries", () => {
  const diary = [
    "# 旧格式",
    "未标日期",
    "# 鱼 · 2026-11-22",
    "## 小节",
    '~~~md',
    "# 样例 · 2026-12-01",
    '~~~',
    "# 鱼 · 2026-11-23",
    "新的一天",
    "# 鱼 · 2026-11-22 （补记）",
    "补记正文",
  ].join("\r\n");
  const entries = indexDiary(diary);
  assert.deepEqual(entries.map((entry) => entry.key), ["2026-11-23", "2026-11-22", ""]);
  assert.match(entries[1].content, /样例 · 2026-12-01/);
  assert.match(entries[1].content, /补记正文/);
  assert.match(entries[2].content, /未标日期/);
  assert.deepEqual(indexDiary("## 旧日记\n正文"), [{ key: "", content: "## 旧日记\n正文" }]);
  assert.deepEqual(indexDiary(" 	"), []);
});

test("reading archive serves confirmed pages and associates diary mentions separately from same-day records", async (t) => {
  const root = box(t);
  const logs = box(t);
  const { store } = await observerFixture(root);
  const videoId = "11111111-1111-4111-a111-111111111111";
  const webId = "22222222-2222-4222-a222-222222222222";
  const pendingId = "33333333-3333-4333-a333-333333333333";
  const bvid = "BV0000000001";
  const title = "从字幕归档回顾潮汐带";
  const pages = ["[0-1] 首段字幕", "[1-2] 第二页字幕"].map((excerpt) => ({
    object: store.object({ excerpt }),
  }));
  const material = store.object({ title });
  const web = {
    id: webId,
    title: "一篇观察潮汐变化的报道",
    kind: "web_page",
    status: "presented",
    reading_complete: true,
    read_completed_at: "2026-11-23T16:00:00Z",
    url: "https://example.test/story",
    sources: [{ object: store.object({ excerpt: "## 网页正文" }) }],
  };
  await store.transaction({}, (draft) => {
    const video = {
      id: videoId, bvid, title: undefined, material, kind: "subtitles",
      status: "presented", reading_complete: true,
      read_completed_at: "2026-11-23T16:20:00Z",
      sources: pages,
    };
    draft.reads.put(video);
    draft.reads.put({ ...video, id: pendingId, reading_complete: false });
    draft.state.resource_reads = { [webId]: web };
  });
  fs.writeFileSync(path.join(logs, "whale-diary.md"),
    `# 11 日记 2026-11-24\n\n今天记了《${title}》。\n\n# 旧日记 2026-11-23\n\n${bvid}`);
  fs.writeFileSync(path.join(logs, "whale-diary-private.md"),
    "# 私人日记 2026-11-24\n\n[来源](https://example.test/story#section)");
  const before = store.read();
  const server = await start(t, root, logs);
  const get = async (path) => {
    const response = await fetch(server.url + "/api/readings" + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.json();
  };
  const newest = await get("?day=2026-11-24&limit=1");
  assert.equal(newest.total, 2);
  assert.equal(newest.pages, 2);
  assert.equal(newest.items[0].title, title);
  assert.equal(newest.items[0].id, videoId);
  assert.equal((await get("?day=2026-11-24&limit=1&page=2")).items[0].id, webId);
  assert.equal((await get("?kind=subtitles&query=" + encodeURIComponent("字幕归档"))).total, 1);
  assert.equal((await get("/text?id=" + videoId + "&page=2")).text, "[1-2] 第二页字幕");
  assert.equal((await get("/text?id=" + webId)).text, "## 网页正文");
  const related = await get("/related?diary=public&day=2026-11-24");
  assert.deepEqual(related.mentioned.map((item) => item.id), [videoId]);
  assert.deepEqual(related.sameDay.map((item) => item.id), [webId]);
  const privateLinks = await get("/related?diary=private&day=2026-11-24");
  assert.deepEqual(privateLinks.mentioned.map((item) => item.id), [webId]);
  assert.deepEqual((await get("/related?diary=public&day=2026-11-23")).mentioned.map((item) => item.id), [videoId]);

  for (const bad of ["/text?id=" + pendingId, "/text?id=" + videoId + "&page=3"])
    assert.equal((await fetch(server.url + "/api/readings" + bad)).status, 404);
  assert.equal((await fetch(server.url + "/api/readings?day=2026-02-30")).status, 400);
  assert.equal((await fetch(server.url + "/api/readings", { headers: { "Sec-Fetch-Site": "same-site" } })).status, 403);
  assert.deepEqual(store.read(), before);
});

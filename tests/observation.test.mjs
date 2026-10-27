import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ObservationStore,
  redact,
} from "../tools/lib/concept-system/store.mjs";
import {
  Observer,
  readSource,
  attachSessionEvents,
} from "../tools/lib/concept-system/observation.mjs";
import { createSessionDelivery } from "../lib/session-delivery.js";
function box(t) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "whale-observe-")),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("atomic journal serializes writers and idempotent transactions; corruption fails closed", async (t) => {
  const root = box(t),
    a = new ObservationStore(root),
    b = new ObservationStore(root);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? a : b).transaction({ key: "k" + i, input: i }, (d, emit) => {
        d.state.count = (d.state.count ?? 0) + 1;
        return emit("test", { i });
      }),
    ),
  );
  assert.equal(a.read().state.count, 8);
  assert.deepEqual(
    a.events().map((e) => e.seq),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  const receipt = await a.transaction({ key: "k1", input: 1 }, () =>
    assert.fail("must not replay"),
  );
  assert.equal(receipt.type, "test");
  await assert.rejects(
    a.transaction({ key: "k1", input: 2 }, () => {}),
    /different input/,
  );
  fs.writeFileSync(a.file, "broken");
  await assert.rejects(a.event("test", {}), /refusing update/);
});
test("versions preserve present, modified, deleted and restored contents; objects verify hashes", async (t) => {
  const store = new ObservationStore(box(t)),
    a = await store.snapshot("persona", "old"),
    b = await store.snapshot("persona", "new");
  assert.deepEqual(await store.snapshot("persona", "new"), b);
  assert.equal(store.versions("persona").length, 2);
  await assert.rejects(
    store.snapshot("persona", "other", { expected: a.hash }),
    /conflict/,
  );
  await store.snapshot("persona", null, { status: "missing" });
  await store.snapshot("persona", "old", { actor: "restore" });
  assert.equal(store.diff("persona", a.id, b.id).before.content, "old");
  assert.equal(store.versions("persona").length, 4);
  fs.writeFileSync(
    path.join(store.directory, "objects", a.hash + ".json"),
    JSON.stringify({ content: "tampered" }),
  );
  assert.throws(() => store.getObject(a.hash), /mismatch/);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});
test("capture allowlists config and rejects symlinks; secrets never reach disk objects", async (t) => {
  const root = box(t),
    file = path.join(root, "config.json"),
    secret = path.join(root, "credentials.json"),
    alias = path.join(root, "persona.md");
  fs.writeFileSync(
    file,
    JSON.stringify({
      persona: { name: "fish" },
      notify: { url: "https://secret/" },
      credentials: { sessdata: "private" },
    }),
  );
  fs.writeFileSync(secret, "SESSDATA=private");
  fs.symlinkSync(secret, alias);
  assert.deepEqual(readSource("config", file).content, {
    persona: { name: "fish" },
  });
  assert.equal(readSource("persona", alias).status, "unreadable");
  const store = new ObservationStore(path.join(root, "audit"));
  const obj = store.object({
    cookie: "private",
    text: "SESSDATA=private Bearer abc https://cdn.bilivideo.com/v?deadline=123&sign=private",
  });
  assert.equal(obj.redacted, true);
  assert.doesNotMatch(
    JSON.stringify(store.getObject(obj.hash)),
    /private|Bearer abc|deadline/,
  );
  assert.equal(redact({ authorization: "secret" }).authorization, "[REDACTED]");
});
test("delivery logs exact prepared payload and receipts; dedup points to prior injection and observes changes", async (t) => {
  const root = box(t),
    store = new ObservationStore(path.join(root, "audit")),
    observer = new Observer({ store, paths: {} });
  let block = "one";
  const sent = [];
  const delivery = createSessionDelivery({
    controller: { create: async () => {}, prompt: async (p) => sent.push(p) },
    dshHome: root,
    cwd: root,
    sessionId: "fish",
    config: () => ({ personaOncePerSession: true }),
    persona: () => block,
    observer,
  });
  await delivery.send({
    requestId: "1",
    content: [{ type: "text", text: "hello" }],
  });
  await delivery.send({
    requestId: "2",
    content: [{ type: "text", text: "again" }],
  });
  block = "two";
  await delivery.send({
    requestId: "3",
    content: [{ type: "text", text: "third" }],
  });
  const prepared = store.events({ type: "prompt.prepared" });
  assert.deepEqual(
    prepared.map((e) => e.data.included),
    [true, false, true],
  );
  assert.equal(prepared[1].data.previous_injection, prepared[0].trace_id);
  assert.deepEqual(
    store.getObject(prepared[0].data.prompt.hash).content,
    sent[0],
  );
  assert.equal(store.events({ type: "prompt.accepted" }).length, 3);
  await observer.response({
    trace_id: prepared[0].trace_id,
    session_id: "fish",
    text: "reply",
    reasoning_kind: "unavailable",
  });
  await assert.rejects(
    observer.response({ trace_id: "other", session_id: "fish", text: "reply" }),
    /matching/,
  );
});
test("audit failure before send prevents send; receipt failure after send never triggers retry", async (t) => {
  const root = box(t);
  let calls = 0;
  const options = {
    controller: {
      create: async () => {},
      prompt: async () => {
        calls++;
      },
    },
    dshHome: root,
    cwd: root,
    sessionId: "fish",
    config: () => ({}),
    persona: () => "",
  };
  await assert.rejects(
    createSessionDelivery({
      ...options,
      observer: {
        prepare: async () => {
          throw Error("disk full");
        },
      },
    }).send({}),
    /disk full/,
  );
  assert.equal(calls, 0);
  await createSessionDelivery({
    ...options,
    observer: {
      prepare: async () => ({ trace_id: "t" }),
      accepted: async () => {
        throw Error("disk full");
      },
    },
  }).send({});
  assert.equal(calls, 1);
});
test("host adapter captures provider events, correlates exact prompts and keeps unrelated turns separate", async (t) => {
  const store = new ObservationStore(box(t)),
    observer = new Observer({ store, paths: {} });
  let handler;
  const adapter = attachSessionEvents(
    {
      on: (_, fn) => {
        handler = fn;
        return () => {};
      },
    },
    observer,
    "fish",
  );
  const trace = await observer.prepare({
    request: { sessionId: "fish", content: [{ type: "text", text: "hello" }] },
    block: "persona",
    sources: [],
    included: true,
  });
  handler(
    { id: "other" },
    { type: "user/message", seq: 0, data: { content: [] } },
  );
  handler(
    { id: "fish" },
    {
      type: "user/message",
      seq: 1,
      data: { content: [{ type: "text", text: "hello" }] },
    },
  );
  handler(
    { id: "fish" },
    {
      type: "assistant/message",
      seq: 2,
      data: {
        message: {
          id: "r",
          content: [
            { type: "reasoning", text: "provided reasoning" },
            { type: "text", text: "reply" },
          ],
        },
      },
    },
  );
  handler({ id: "fish" }, { type: "turn/end", seq: 3, data: {} });
  handler(
    { id: "fish" },
    {
      type: "user/message",
      seq: 4,
      data: { content: [{ type: "text", text: "another user turn" }] },
    },
  );
  await adapter.stop();
  const events = store.events({ type: "host.session_event" });
  assert.equal(events.length, 4);
  assert.equal(events[1].trace_id, trace.trace_id);
  assert.equal(events[1].data.reasoning_kind, "provider_reasoning");
  assert.notEqual(events[3].trace_id, trace.trace_id);
});
test("watcher captures external edits and deletion and stops cleanly", async (t) => {
  const root = box(t),
    file = path.join(root, "persona.md");
  fs.writeFileSync(file, "before");
  const store = new ObservationStore(path.join(root, "audit")),
    observer = new Observer({ store, paths: { persona: file } });
  await observer.capture();
  const stop = observer.watch();
  t.after(stop);
  const waitFor = async (predicate) => {
    for (let i = 0; i < 40; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail("watch event timed out");
  };
  fs.writeFileSync(file, "after");
  await waitFor(() => store.versions("persona").length === 2);
  fs.rmSync(file);
  await waitFor(() => store.versions("persona").at(-1).status === "missing");
  await stop();
});
test("redaction covers camelCase and header secrets, quoted JSON and signed URLs", () => {
  const x = redact({
    apiKey: "s1",
    accessToken: "s2",
    "X-Other": "visible",
    "Proxy-Authorization": "s3",
    "Set-Cookie": "s4",
    text: '{"apiKey":"s5"} https://example.com/private?access_token=s6',
  });
  assert.doesNotMatch(JSON.stringify(x), /s[1-6]/);
  assert.match(JSON.stringify(x), /visible/);
});
test("SQLite failure rolls back learning state and all events together", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const store = new ObservationStore(box(t));
  await store.transaction({}, (d, emit) => {
    d.state.value = 1;
    emit("before");
  });
  const before = store.read(),
    db = new DatabaseSync(store.file);
  db.exec(
    "CREATE TRIGGER reject_after BEFORE INSERT ON events WHEN NEW.type='after' BEGIN SELECT RAISE(ABORT,'injected disk failure'); END;",
  );
  db.close();
  await assert.rejects(
    store.transaction({}, (d, emit) => {
      d.state.value = 2;
      emit("during");
      emit("after");
    }),
    /injected disk failure/,
  );
  assert.deepEqual(store.read(), before);
});

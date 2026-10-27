import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ObservationStore,
  stable,
} from "../tools/lib/concept-system/store.mjs";
import { ConceptEngine } from "../tools/lib/concept-system/engine.mjs";
function box(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whale-concepts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1793100000000;
  const store = new ObservationStore(root, { now: () => now });
  return {
    store,
    engine: new ConceptEngine(store),
    advance: (n) => {
      now += n;
    },
  };
}
async function add(
  engine,
  {
    key = "a",
    content = "康德",
    sourceId = key,
    subject = "fish",
    interpretation = "explicit",
    collection = "哲学",
    tags = ["topic"],
  } = {},
) {
  const member = await engine.call("concept_propose", {
    key,
    source: {
      id: sourceId,
      type: "conversation",
      actor: "user",
      excerpt: "最近想了解" + content,
    },
    subject,
    content,
    tags,
    interpretation,
  });
  const review = await engine.call("concept_review", {
    key: "review-" + key,
    candidate_id: member.id,
    status: "accepted",
    reason: "有明确上下文支持，保存成员而不合并",
    collections: [{ name: collection }],
  });
  return { member: member.id, group: review.collection_ids[0] };
}
function input(a, b, extra = {}) {
  return {
    question: "今晚看什么",
    scene: "watch",
    seed: "seed-1",
    options: [
      {
        label: "学习",
        reason: "还有问题值得探索",
        contributions: [
          {
            collection_id: a.group,
            member_id: a.member,
            relevance: 1,
            strength: 0.8,
            reason: "明确探索兴趣",
          },
        ],
      },
      {
        label: "娱乐",
        reason: "休息一下",
        contributions: [
          {
            collection_id: b.group,
            member_id: b.member,
            relevance: 1,
            strength: 0.8,
            reason: "适合休息",
          },
        ],
      },
    ],
    ...extra,
  };
}
test("candidates need assessment; similar items remain separate, multi-membership and subjects retain provenance", async (t) => {
  const { engine } = box(t),
    a = await add(engine),
    b = await add(engine, { key: "b", content: "佛教" });
  let q = await engine.call("concept_query", {});
  assert.equal(q.members.length, 2);
  assert.equal(q.collections.length, 1);
  assert.equal(q.collections[0].members.length, 2);
  await engine.call("concept_review", {
    key: "review-extra",
    candidate_id: a.member,
    status: "accepted",
    reason: "也与历史有关",
    collections: [{ name: "思想史" }],
  });
  q = await engine.call("concept_query", {});
  assert.equal(q.collections.length, 2);
  assert.equal(q.members.length, 2);
  await add(engine, { key: "user", subject: "user" });
  assert.equal(
    (await engine.call("concept_query", { subject: "user" })).members.length,
    1,
  );
  const pending = await engine.call("concept_propose", {
    key: "mention",
    source: {
      id: "mention",
      actor: "user",
      type: "conversation",
      excerpt: "视频提到康德",
    },
    subject: "fish",
    content: "康德解读",
    tags: ["topic"],
  });
  assert.equal(pending.status, "pending");
  assert.equal(
    (await engine.call("concept_query", { status: "pending" })).members.length,
    1,
  );
});
test("same source replay cannot inflate membership or confidence; conflicting evidence rejected", async (t) => {
  const { engine, store } = box(t);
  await add(engine);
  const before = engine.query({ limit: 100 }).collections[0].strength;
  await add(engine, { key: "same", sourceId: "a" });
  assert.equal(engine.query({ limit: 100 }).collections[0].strength, before);
  await assert.rejects(
    add(engine, { key: "different", sourceId: "a", content: "changed claim" }),
    /different evidence/,
  );
  assert.equal(Object.keys(store.read().state.concepts.members).length, 1);
});
test("previews are reproducible, preserve state, expose terms and respect ineligible options and shared evidence", async (t) => {
  const { engine, store } = box(t),
    a = await add(engine),
    b = await add(engine, { key: "b", content: "动漫", collection: "娱乐" });
  const before = stable(store.read().state),
    x = input(a, b),
    p = await engine.call("decision_preview", x),
    q = await engine.call("decision_preview", x);
  assert.deepEqual(p.rows, q.rows);
  assert.equal(stable(store.read().state), before);
  assert.equal(
    (await engine.call("decision_replay", { preview_id: p.preview_id }))
      .matches,
    true,
  );
  assert.equal(p.rows[0].contributions[0].fatigue, 0);
  const blocked = await engine.call("decision_preview", {
    ...x,
    options: x.options.map((o) => ({ ...o, eligible: o.label === "娱乐" })),
  });
  assert.equal(blocked.winner, "娱乐");
  const duplicate = structuredClone(x);
  duplicate.options[0].contributions.push({
    ...duplicate.options[0].contributions[0],
  });
  const dup = await engine.call("decision_preview", duplicate);
  assert.equal(dup.rows[0].contributions.length, 1);
  await assert.rejects(
    engine.call("decision_preview", {
      ...x,
      options: [x.options[0], x.options[0]],
    }),
    /unique/,
  );
});
test("commit is atomic, idempotent, conflict checked; only selected scene fatigue changes and later recovers", async (t) => {
  const { engine, store, advance } = box(t),
    a = await add(engine),
    b = await add(engine, { key: "b", content: "动漫", collection: "娱乐" });
  const p = await engine.call("decision_preview", input(a, b)),
    args = {
      key: "commit",
      preview_id: p.preview_id,
      selected: "学习",
      reason: "今天先继续研究康德",
    };
  const result = await engine.call("decision_commit", args),
    count = store.read().seq;
  assert.deepEqual(await engine.call("decision_commit", args), result);
  assert.equal(store.read().seq, count);
  assert.equal(store.read().state.concepts.collections[a.group].reward, 0);
  assert.equal(store.read().state.concepts.collections[b.group].reward, 0);
  let q = await engine.call("decision_preview", input(a, b));
  assert.equal(q.rows[0].contributions[0].fatigue, 0.2);
  const other = await engine.call(
    "decision_preview",
    input(a, b, { scene: "expression" }),
  );
  assert.equal(other.rows[0].contributions[0].fatigue, 0);
  advance(6 * 3600000);
  q = await engine.call("decision_preview", input(a, b));
  assert.ok(Math.abs(q.rows[0].contributions[0].fatigue - 0.1) < 1e-8);
  await add(engine, { key: "new", content: "纪录片" });
  await assert.rejects(
    engine.call("decision_commit", {
      key: "stale",
      preview_id: q.preview_id,
      reason: "过时输入",
    }),
    /conflict/,
  );
  assert.equal(
    (await engine.call("decision_replay", { preview_id: p.preview_id }))
      .matches,
    true,
  );
});
test("feedback requires evidence, neutral does not punish, repeat evidence cannot farm rewards", async (t) => {
  const { engine, store } = box(t),
    a = await add(engine),
    b = await add(engine, { key: "b", content: "动漫", collection: "娱乐" });
  const p = await engine.call("decision_preview", input(a, b)),
    d = await engine.call("decision_commit", {
      key: "c",
      preview_id: p.preview_id,
      selected: "学习",
      reason: "继续研究",
    });
  await assert.rejects(
    engine.call("decision_feedback", {
      key: "bad",
      decision_id: d.id,
      actor: "user",
      outcome: "positive",
      reason: "猜用户喜欢",
    }),
    /user source/,
  );
  await engine.call("decision_feedback", {
    key: "unknown",
    decision_id: d.id,
    actor: "fish",
    outcome: "unknown",
    reason: "暂时没有反馈",
  });
  assert.equal(store.read().state.concepts.collections[a.group].reward, 0);
  await engine.call("concept_propose", {
    key: "feedback-source",
    subject: "fish",
    source: {
      id: "feedback-a",
      actor: "user",
      type: "feedback",
      excerpt: "这次选择很好",
    },
    content: "明确的结果反馈",
    tags: ["belief"],
  });
  const f = {
    decision_id: d.id,
    actor: "user",
    source_id: "feedback-a",
    outcome: "positive",
    reason: "收到明确反馈",
  };
  const x = await engine.call("decision_feedback", { key: "f1", ...f }),
    y = await engine.call("decision_feedback", { key: "f2", ...f });
  assert.equal(x.id, y.id);
  assert.equal(store.read().state.concepts.collections[a.group].reward, 0.1);
});
test("render respects budget, separate subjects, exposes exclusions and never overwrites persona", async (t) => {
  const { engine, store } = box(t);
  await add(engine, { content: "一段足够长的兴趣描述".repeat(20) });
  await add(engine, {
    key: "b",
    content: "短句优先",
    tags: ["sentence_pattern"],
    collection: "说话",
  });
  await add(engine, { key: "user", subject: "user", content: "用户特有兴趣" });
  const r = await engine.call("personal_render", {
    scene: "general",
    budget: 100,
  });
  assert.ok([...r.text].length <= 100);
  assert.ok(r.omitted.length);
  assert.doesNotMatch(r.text, /用户特有兴趣/);
  assert.equal(store.events({ type: "personal.rendered" }).length, 1);
});
test("strict input validation blocks malformed scores, unknown references, reserved identifiers and duplicate actions", async (t) => {
  const { engine } = box(t);
  await assert.rejects(
    engine.call("concept_propose", {
      key: "x",
      subject: "fish",
      source: {
        id: "__proto__",
        actor: "user",
        type: "conversation",
        excerpt: "hi",
      },
      content: "x",
      tags: ["topic"],
    }),
  );
  await assert.rejects(engine.call("concept_query", { arbitrary: true }));
  const a = await add(engine),
    b = await add(engine, { key: "b", content: "动漫", collection: "娱乐" }),
    x = input(a, b);
  x.options[0].contributions[0].strength = 2;
  await assert.rejects(engine.call("decision_preview", x));
});
test("personal context is shadow by default; active context participates in injection hash and versions", async (t) => {
  const { engine, store } = box(t);
  const { Observer } =
    await import("../tools/lib/concept-system/observation.mjs");
  const { preparePersonalContext } =
    await import("../tools/lib/concept-system/personal-context.mjs");
  const observer = new Observer({ store, paths: {} });
  await add(engine, {
    content: "短句优先",
    tags: ["sentence_pattern"],
    collection: "说话",
  });
  const shadow = await preparePersonalContext(observer);
  assert.equal(shadow.text, "");
  assert.match(shadow.source.content.text, /短句优先/);
  const active = await preparePersonalContext(observer, { mode: "active" });
  assert.match(active.text, /短句优先/);
  assert.equal(store.versions("personal_rendered").length, 2);
  assert.ok(store.versions("concept_state").length >= 2);
  const root = store.directory;
  const { createSessionDelivery } = await import("../lib/session-delivery.js");
  const sent = [];
  const delivery = createSessionDelivery({
    controller: { create: async () => {}, prompt: async (p) => sent.push(p) },
    dshHome: root,
    cwd: root,
    sessionId: "s",
    config: () => ({ personaOncePerSession: true }),
    persona: async () => {
      const p = await preparePersonalContext(observer, { mode: "active" });
      return { text: "identity\n" + p.text, sources: [p.source] };
    },
    observer,
  });
  await delivery.send({ content: [{ type: "text", text: "hello" }] });
  await delivery.send({ content: [{ type: "text", text: "again" }] });
  await add(engine, {
    key: "new",
    content: "先说结论",
    tags: ["sentence_pattern"],
    collection: "说话",
  });
  await delivery.send({ content: [{ type: "text", text: "third" }] });
  assert.deepEqual(
    store.events({ type: "prompt.prepared" }).map((e) => e.data.included),
    [true, false, true],
  );
});
test("renamed duplicate sources do not increase evidence confidence without bound", async (t) => {
  const { engine } = box(t);
  const source = {
    id: "s0",
    type: "conversation",
    actor: "user",
    excerpt: "同一条原文提到康德",
  };
  async function candidate(i, content) {
    const m = await engine.call("concept_propose", {
      key: "p" + i,
      source: { ...source, id: "s" + i },
      subject: "fish",
      content,
      tags: ["topic"],
    });
    return engine.call("concept_review", {
      key: "r" + i,
      candidate_id: m.id,
      status: "accepted",
      reason: "记录原文",
      collections: [{ name: "哲学" }],
    });
  }
  await candidate(0, "康德");
  await candidate(1, "康德相关概念1");
  const strength = engine.query({ limit: 100 }).collections[0].strength;
  for (let i = 2; i < 8; i++) await candidate(i, "康德相关概念" + i);
  assert.equal(engine.query({ limit: 100 }).collections[0].strength, strength);
});
test("reserved scene identifiers and unknown feedback evidence cannot poison persisted state", async (t) => {
  const { engine, store } = box(t),
    a = await add(engine),
    b = await add(engine, { key: "b", content: "动漫", collection: "娱乐" });
  const before = stable(store.read().state);
  await assert.rejects(
    engine.call("decision_preview", input(a, b, { scene: "__proto__" })),
  );
  assert.equal(stable(store.read().state), before);
  const p = await engine.call("decision_preview", input(a, b)),
    d = await engine.call("decision_commit", {
      key: "c",
      preview_id: p.preview_id,
      reason: "选定建议",
    });
  await assert.rejects(
    engine.call("decision_feedback", {
      key: "f",
      decision_id: d.id,
      actor: "fish",
      source_id: "missing",
      outcome: "positive",
      reason: "没有证据",
    }),
    /Unknown feedback evidence/,
  );
});

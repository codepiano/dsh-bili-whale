import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConceptEngine } from "../tools/lib/concept-system/engine.mjs";
import {
  ObservationStore,
  stable,
} from "../tools/lib/concept-system/store.mjs";
import { ObserverReader } from "../tools/lib/concept-system/observer-read.mjs";
function box(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whale-exploration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1793100000000;
  const store = new ObservationStore(root, { now: () => now++ });
  return { root, store, engine: new ConceptEngine(store) };
}
let serial = 0;
const key = () => "test-" + serial++;
async function member(
  engine,
  name = "康德",
  group = "哲学",
  subject = "fish",
  source,
) {
  const m = await engine.call("concept_propose", {
    key: key(),
    subject,
    content: name,
    tags: ["topic"],
    source: source ?? {
      id: key(),
      actor: "third_party",
      type: "video",
      excerpt: "来源正文：" + name,
      ref: "video/" + key(),
    },
  });
  if (!group) return m;
  const r = await engine.call("concept_review", {
    key: key(),
    candidate_id: m.id,
    status: "accepted",
    reason: "来源支持",
    collections: [{ name: group }],
  });
  return { m, group: r.collection_ids[0] };
}
async function question(engine, a, extra = {}) {
  return engine.call("exploration_question", {
    key: key(),
    collection_id: a.group,
    question: "自由意志与因果律怎样相容？",
    next_step: "寻找解释与反例",
    reason: "当前理解仍有缺口",
    ...extra,
  });
}
async function plan(engine, seed = "plan") {
  return engine.call("exploration_plan", { seed });
}
async function configure(engine, ratios) {
  return engine.call("exploration_configure", {
    key: key(),
    ratios,
    reason: "测试配置",
  });
}
async function preview(engine, p, a, q, m, extra = {}) {
  const target =
    p.path === "deep"
      ? { collection_id: a.group, question_id: q.id }
      : p.path === "revisit"
        ? { collection_id: a.group }
        : { candidate_id: m.id };
  return engine.call("decision_preview", {
    question: "下一步探索什么",
    scene: "watch",
    seed: "score",
    exploration: {
      path: p.path,
      seed: p.seed,
      state_version: p.state_version,
      reason: "延续问题或补充概念边界",
    },
    options: ["解释", "反例"].map((label) => ({
      label,
      target,
      reason: "真实材料有相关线索",
      contributions:
        p.path === "discover"
          ? []
          : [
              {
                collection_id: a.group,
                member_id: a.m.id,
                relevance: 1,
                strength: 0.8,
                reason: "有来源支持",
              },
            ],
    })),
    ...extra,
  });
}
async function commit(engine, p, extra = {}) {
  return engine.call("decision_commit", {
    key: key(),
    preview_id: p.preview_id,
    reason: "按本次问题选择",
    ...extra,
  });
}
test("ratios validate, persist across restart and version configuration without changing ordinary scoring", async (t) => {
  const { engine, store, root } = box(t);
  const before = stable(store.state());
  for (const ratios of [
    { deep: 0, revisit: 0, discover: 0 },
    { deep: -1, revisit: 1, discover: 1 },
    { deep: 0.5, revisit: 0.2, discover: 0.2 },
  ])
    await assert.rejects(configure(engine, ratios));
  assert.equal(stable(store.state()), before);
  await configure(engine, { deep: 0.5, revisit: 0.3, discover: 0.2 });
  const fresh = new ConceptEngine(new ObservationStore(root));
  assert.equal(
    (await fresh.call("exploration_query", {})).config.ratios.deep,
    0.5,
  );
  assert.equal(store.events({ type: "exploration.configured" }).length, 1);
  assert.equal(store.versions("concept_state").length, 1);
});
test("cold start discovers; planning is read-only and repeatable; zero and unavailable routes are explicit", async (t) => {
  const { engine, store } = box(t);
  const before = stable(store.state());
  const p = await plan(engine);
  assert.equal(p.path, "discover");
  assert.deepEqual(p.unavailable, ["deep", "revisit"]);
  assert.deepEqual((await plan(engine)).weights, p.weights);
  assert.equal(stable(store.state()), before);
  await configure(engine, { deep: 1, revisit: 0, discover: 0 });
  await assert.rejects(plan(engine), /No available/);
});
test("deep decision records targets, override reasons and sourced progress atomically, exposure only after reading", async (t) => {
  const { engine, store, root } = box(t),
    a = await member(engine),
    q = await question(engine, a);
  await configure(engine, { deep: 1, revisit: 0, discover: 0 });
  const p = await preview(engine, await plan(engine), a, q);
  assert.equal(
    (await engine.call("decision_replay", { preview_id: p.preview_id }))
      .matches,
    true,
  );
  assert.equal((await plan(engine)).counts.deep, 0);
  const d = await commit(engine, p, {
    selected: p.winner === "解释" ? "反例" : "解释",
  });
  assert.equal(d.overridden, true);
  assert.equal(d.exploration.target_snapshot.question, q.question);
  assert.equal((await plan(engine)).counts.deep, 0);
  const progress = {
    key: key(),
    decision_id: d.id,
    outcome: "completed",
    source_ids: [a.m.source_id],
    answered: "找到了一种相容论解释",
    remaining: "其反对意见是什么",
    next_step: "比较反对意见",
    reason: "实际阅读来源后记录",
  };
  const saved = await engine.call("exploration_progress", progress);
  assert.deepEqual(await engine.call("exploration_progress", progress), saved);
  await assert.rejects(
    engine.call("exploration_progress", { ...progress, key: key() }),
    /already recorded/,
  );
  assert.equal((await plan(engine)).counts.deep, 1);
  const reader = new ObserverReader(root),
    detail = reader.decision(p.preview_id);
  assert.equal(
    detail.committed.exploration.progress.answered,
    progress.answered,
  );
  const query = await engine.call("exploration_query", {});
  assert.equal(query.questions[0].next_step, progress.next_step);
  assert.equal(query.decisions[0].exploration.reason, "延续问题或补充概念边界");
  assert.equal(
    store.events({ decision_id: d.id, type: "exploration.progress_recorded" })
      .length,
    1,
  );
  assert.equal(store.state().concepts.collections[a.group].reward, 0);
  assert.equal(
    (await engine.call("decision_replay", { preview_id: p.preview_id }))
      .matches,
    true,
  );
});
test("discovery requires pending provenance, failed and skipped do not count, no inference of liking", async (t) => {
  const { engine, store } = box(t),
    m = await member(engine, "陌生术语", null);
  await configure(engine, { deep: 0, revisit: 0, discover: 1 });
  for (const outcome of ["failed", "skipped"]) {
    const p = await preview(engine, await plan(engine), null, null, m),
      d = await commit(engine, p);
    await engine.call("exploration_progress", {
      key: key(),
      decision_id: d.id,
      outcome,
      reason: "未能接触材料",
    });
  }
  assert.equal((await plan(engine)).counts.discover, 0);
  assert.equal(store.state().concepts.members[m.id].status, "pending");
  const p = await preview(engine, await plan(engine), null, null, m),
    d = await commit(engine, p);
  const before = stable(store.state());
  await assert.rejects(
    engine.call("exploration_progress", {
      key: key(),
      decision_id: d.id,
      outcome: "completed",
      reason: "没有来源",
    }),
    /source evidence/,
  );
  await assert.rejects(
    engine.call("exploration_progress", {
      key: key(),
      decision_id: d.id,
      outcome: "skipped",
      answered: "假进展",
      reason: "跳过",
    }),
    /cannot report/,
  );
  assert.equal(stable(store.state()), before);
  await engine.call("exploration_progress", {
    key: key(),
    decision_id: d.id,
    outcome: "engaged",
    source_ids: [m.source_id],
    reason: "看到了原文",
  });
  assert.equal((await plan(engine)).counts.discover, 1);
  assert.equal(store.state().concepts.members[m.id].status, "pending");
});
test("state changes invalidate plans; foreign subjects, wrong targets and sources cannot leak or mutate state", async (t) => {
  const { engine, store } = box(t),
    a = await member(engine),
    q = await question(engine, a);
  await configure(engine, { deep: 1, revisit: 0, discover: 0 });
  const stale = await plan(engine);
  const other = await member(engine, "用户概念", "用户集合", "user");
  await assert.rejects(preview(engine, stale, a, q), /state conflict/);
  const p = await plan(engine),
    before = stable(store.state());
  await assert.rejects(question(engine, other), /same subject/);
  await assert.rejects(preview(engine, p, other, q), /match the question/);
  await assert.rejects(
    engine.call("exploration_question", {
      key: key(),
      question_id: q.id,
      collection_id: a.group,
      subject: "fish",
      scene: "expression",
      question: "换场景",
      next_step: "下一步",
      reason: "测试",
    }),
    /cannot change/,
  );
  assert.equal(stable(store.state()), before);
  await engine.call("exploration_question", {
    key: key(),
    question_id: q.id,
    collection_id: a.group,
    question: q.question,
    status: "paused",
    next_step: "暂缓",
    reason: "暂无新材料",
  });
  await assert.rejects(plan(engine), /No available/);
});
test("sparse ranking favors fewer independent sources and neglect; renamed evidence shares one slot and exposure", async (t) => {
  const { engine } = box(t);
  const source = {
    id: "shared",
    type: "video",
    actor: "third_party",
    excerpt: "同一份材料",
  };
  const a = await member(engine, "稀疏", "稀疏组", "fish", source);
  await member(engine, "稀疏别名", "改名组", "fish", source);
  const b = await member(engine, "丰富1", "丰富组");
  await member(engine, "丰富2", "丰富组");
  await member(engine, "丰富3", "丰富组");
  await configure(engine, { deep: 0, revisit: 1, discover: 0 });
  let p = await plan(engine);
  assert.equal(p.revisit.length, 2);
  assert.equal(p.revisit[0].independent_sources, 1);
  const d = await commit(engine, await preview(engine, p, a));
  await engine.call("exploration_progress", {
    key: key(),
    decision_id: d.id,
    outcome: "completed",
    source_ids: [a.m.source_id],
    reason: "实际阅读",
  });
  p = await plan(engine);
  assert.equal(
    p.revisit.find((g) => g.independent_sources === 1).exposure_count,
    1,
  );
  assert.equal(
    p.revisit.find((g) => g.collection_id === b.group).exposure_count,
    0,
  );
});
test("actual-exposure scheduling tracks configured ratios over time and preview retries consume no budget", async (t) => {
  const { engine } = box(t),
    a = await member(engine),
    q = await question(engine, a),
    m = await member(engine, "新词", null);
  const counts = { deep: 0, revisit: 0, discover: 0 };
  for (let i = 0; i < 80; i++) {
    const p = await plan(engine, "schedule-" + i);
    assert.equal((await plan(engine, "schedule-" + i)).path, p.path);
    const v = await preview(engine, p, a, q, m),
      d = await commit(engine, v);
    await engine.call("exploration_progress", {
      key: key(),
      decision_id: d.id,
      outcome: "completed",
      source_ids: [a.m.source_id],
      remaining: "仍需比较不同解释",
      next_step: "寻找下一份材料",
      reason: "来源阅读记录",
    });
    counts[p.path]++;
  }
  assert.ok(Math.abs(counts.deep / 80 - 0.6) < 0.1, JSON.stringify(counts));
  assert.ok(Math.abs(counts.revisit / 80 - 0.25) < 0.1, JSON.stringify(counts));
  assert.ok(
    Math.abs(counts.discover / 80 - 0.15) < 0.1,
    JSON.stringify(counts),
  );
  const other = await engine.call("exploration_plan", {
    subject: "user",
    scene: "expression",
    seed: "separate",
  });
  assert.deepEqual(other.counts, { deep: 0, revisit: 0, discover: 0 });
});

test("recording discovery evidence does not reroll a path before actual exposure; scene-specific evidence stays isolated", async (t) => {
  const { engine } = box(t),
    a = await member(engine);
  await question(engine, a);
  const first = await plan(engine);
  await member(engine, "新发现", null);
  const second = await plan(engine);
  assert.equal(second.path, first.path);
  assert.notEqual(second.state_version, first.state_version);
  const m = await engine.call("concept_propose", {
    key: key(),
    subject: "user",
    scene: "expression",
    content: "只用于表达",
    tags: ["word"],
    source: {
      id: key(),
      actor: "user",
      type: "conversation",
      excerpt: "表达素材",
    },
  });
  await engine.call("concept_review", {
    key: key(),
    candidate_id: m.id,
    status: "accepted",
    reason: "记录表达",
    collections: [{ name: "表达" }],
  });
  const other = await engine.call("exploration_plan", {
    subject: "user",
    scene: "watch",
    seed: "scene",
  });
  assert.equal(other.available.revisit, false);
  assert.equal(other.path, "discover");
});

test("configured exploration participates in budgeted learning context without changing expression-only rendering", async (t) => {
  const { engine } = box(t);
  await configure(engine, { deep: 0.6, revisit: 0.25, discover: 0.15 });
  const r = await engine.call("personal_render", {
    scene: "watch",
    budget: 1000,
  });
  assert.match(r.text, /feed_assess/);
  assert.match(r.text, /问题进展/);
  assert.ok([...r.text].length <= 1000);
  const short = await engine.call("personal_render", {
    scene: "watch",
    budget: 100,
  });
  assert.ok([...short.text].length <= 100);
  const expression = await engine.call("personal_render", {
    scene: "expression",
    budget: 1000,
  });
  assert.doesNotMatch(expression.text, /exploration_plan/);
});

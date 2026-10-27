import { ObservationStore } from "../../tools/lib/concept-system/store.mjs";
import { ConceptEngine } from "../../tools/lib/concept-system/engine.mjs";
import { Observer } from "../../tools/lib/concept-system/observation.mjs";
export async function observerFixture(directory) {
  const store = new ObservationStore(directory),
    engine = new ConceptEngine(store),
    observer = new Observer({ store, paths: {} });
  const old = await store.snapshot(
    "persona",
    "# 我是谁\n我是一条会看视频的鱼。\n\n# 表达\n短句优先。\n",
    { actor: "manual" },
  );
  const newer = await store.snapshot(
    "persona",
    "# 我是谁\n我是一条会看视频的鱼。\n\n# 表达\n短句优先，先说判断，再给理由。\n不确定就说不确定。\n",
    { actor: "external_unknown" },
  );
  async function member(
    key,
    content,
    collection,
    tags = ["topic"],
    subject = "fish",
  ) {
    const m = await engine.call("concept_propose", {
      key,
      subject,
      source: {
        id: key,
        actor: "user",
        type: "conversation",
        excerpt: "示例素材：" + content,
      },
      content,
      tags,
      triggers: ["讨论或选片时"],
      interpretation: "explicit",
    });
    const r = await engine.call("concept_review", {
      key: "r-" + key,
      candidate_id: m.id,
      status: "accepted",
      reason: "保留原文与适用情境，作为待观察的偏好线索。",
      collections: [{ name: collection }],
    });
    return { member: m.id, group: r.collection_ids[0] };
  }
  const a = await member("philosophy", "康德与知识的边界", "哲学与概念辨析"),
    b = await member("entertainment", "轻松的动漫与纪录片", "轻松娱乐"),
    c = await member("expression", "先说结论，再展开理由", "表达与惯用句式", [
      "sentence_pattern",
    ]);
  await member("user", "佛教与思想史", "用户明确提到的兴趣", ["topic"], "user");
  const request = {
    sessionId: "fixture-session",
    requestId: "fixture-request",
    content: [{ type: "text", text: "这是一条测试提示，不是真实用户记录。" }],
  };
  const trace = await observer.prepare({
    request,
    block: "短句优先，先说判断。",
    sources: [
      {
        role: "persona",
        status: "present",
        content: store.getObject(newer.hash).content,
      },
    ],
    included: true,
  });
  await observer.accepted(trace);
  const args = {
    trace_id: trace.trace_id,
    question: "今晚先看哲学，还是轻松一点？",
    scene: "watch",
    seed: "fixture-seed",
    options: [
      {
        label: "继续学习",
        reason: "康德的问题还没有看完，可以继续探索。",
        contributions: [
          {
            collection_id: a.group,
            member_id: a.member,
            relevance: 0.9,
            strength: 0.9,
            reason: "有明确的探索线索。",
          },
        ],
      },
      {
        label: "轻松娱乐",
        reason: "今天可以换一种节奏。",
        contributions: [
          {
            collection_id: b.group,
            member_id: b.member,
            relevance: 0.8,
            strength: 0.65,
            reason: "休息与兴趣同样是有效候选。",
          },
        ],
      },
    ],
  };
  const preview = await engine.call("decision_preview", args),
    decision = await engine.call("decision_commit", {
      key: "commit",
      preview_id: preview.preview_id,
      selected: "轻松娱乐",
      reason: "今天先轻松一下；保留学习计划，下次再继续。",
    });
  await engine.call("concept_propose", {
    key: "feedback-source",
    subject: "fish",
    source: {
      id: "feedback-source",
      actor: "user",
      type: "feedback",
      excerpt: "这个节奏挺合适",
    },
    content: "明确的节奏反馈",
    tags: ["belief"],
  });
  await engine.call("decision_feedback", {
    key: "feedback",
    decision_id: decision.id,
    actor: "user",
    source_id: "feedback-source",
    outcome: "positive",
    reason: "用户明确认可这次的节奏。",
  });
  const pending = await engine.call("decision_preview", {
    ...args,
    question: "接下来用怎样的语气表达？",
    scene: "general",
    seed: "expression",
    options: [
      {
        label: "简短直接",
        reason: "符合当前表达素材。",
        contributions: [
          {
            collection_id: c.group,
            member_id: c.member,
            relevance: 1,
            strength: 0.8,
            reason: "适合当前场景。",
          },
        ],
      },
      {
        label: "详细展开",
        reason: "保留充分解释的可能性。",
        contributions: [],
      },
    ],
  });
  await observer.response({
    trace_id: trace.trace_id,
    session_id: "fixture-session",
    response_id: "fixture-response",
    text: "今晚先轻松一点，下次继续。",
    reasoning: "这是测试夹具提供的示例推理，不是真实 DS 生成内容。",
    reasoning_kind: "provider_reasoning",
    source: "test_fixture",
  });
  return {
    store,
    engine,
    a,
    b,
    c,
    old,
    newer,
    preview,
    decision,
    pending,
    trace,
  };
}

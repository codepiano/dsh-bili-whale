import crypto from "node:crypto";
import { hash } from "./store.mjs";

export const EXPLORATION_DEFAULTS = Object.freeze({
  algorithm: "exploration-v1",
  ratios: Object.freeze({ deep: 0.6, revisit: 0.25, discover: 0.15 }),
  history_window: 40,
});
const paths = ["deep", "revisit", "discover"];
const config = (s) => s.exploration?.config ?? EXPLORATION_DEFAULTS;
const questions = (s) => Object.values(s.exploration?.questions ?? {});
const sourceKey = (s, id) => {
  const source = s.sources[id];
  return hash([source.actor, source.type, source.ref || source.excerpt]);
};
const evidence = (s, c, scene) =>
  [
    ...new Set(
      c.members
        .map((id) => s.members[id])
        .filter(
          (m) =>
            m?.status === "accepted" &&
            (!scene || m.scene === "general" || m.scene === scene),
        )
        .map((m) => sourceKey(s, m.source_id)),
    ),
  ].sort();
const decisions = (s, subject, scene) =>
  Object.values(s.decisions)
    .filter((d) => d.subject === subject && d.scene === scene && d.exploration)
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
const exposed = (d) =>
  !!d.exploration.exposure ||
  ["engaged", "completed"].includes(d.exploration.progress?.outcome);
const exposedAt = (d) =>
  d.exploration.exposure?.at ?? d.exploration.progress?.at;
const validGroup = (s, id, subject, scene) => {
  const c = s.collections[id];
  if (!c || c.subject !== subject || !evidence(s, c, scene).length)
    throw Error("Exploration needs an accepted collection of the same subject");
  return c;
};
function checkSources(s, ids) {
  for (const id of ids)
    if (!Object.hasOwn(s.sources, id))
      throw Error("Unknown exploration source");
}
export function explorationQuery(s, input) {
  return {
    state_version: hash(s),
    config: structuredClone(config(s)),
    questions: questions(s)
      .filter((q) => q.subject === input.subject && q.scene === input.scene)
      .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id))
      .slice(0, input.limit),
    decisions: decisions(s, input.subject, input.scene).slice(0, input.limit),
  };
}
export function explorationPlan(s, input, now) {
  const cfg = config(s),
    history = decisions(s, input.subject, input.scene).filter(exposed);
  history.sort(
    (a, b) => exposedAt(b) - exposedAt(a) || b.id.localeCompare(a.id),
  );
  const recent = history.slice(0, cfg.history_window);
  const counts = Object.fromEntries(
    paths.map((p) => [
      p,
      recent.filter((d) => d.exploration.path === p).length,
    ]),
  );
  const open = questions(s)
    .filter(
      (q) =>
        q.subject === input.subject &&
        q.scene === input.scene &&
        q.status === "active" &&
        s.collections[q.collection_id]?.subject === input.subject &&
        evidence(s, s.collections[q.collection_id], input.scene).length,
    )
    .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id));
  const groups = Object.values(s.collections)
    .filter(
      (c) => c.subject === input.subject && evidence(s, c, input.scene).length,
    )
    .map((c) => {
      const sources = evidence(s, c, input.scene);
      // Identical evidence in renamed groups shares exposure history and one recommendation slot.
      const sameEvidence = new Set(
        Object.values(s.collections)
          .filter(
            (other) =>
              other.subject === c.subject &&
              hash(evidence(s, other, input.scene)) === hash(sources),
          )
          .map((other) => other.id),
      );
      const seen = history.filter((d) =>
        (d.exploration.target.collection_id
          ? [d.exploration.target.collection_id]
          : d.collection_ids
        ).some((id) => sameEvidence.has(id)),
      );
      const last = Math.max(0, ...seen.map((d) => exposedAt(d)));
      const scarcity = 1 / Math.sqrt(sources.length);
      const neglect = last
        ? Math.min(1, Math.max(0, now - last) / (7 * 86400000))
        : 1;
      return {
        collection_id: c.id,
        name: c.name,
        independent_sources: sources.length,
        exposure_count: seen.length,
        last_exposed_at: last || null,
        priority: scarcity + neglect + 1 / (1 + seen.length),
        evidence_key: hash(sources),
        reason: `独立来源 ${sources.length} 个，实际曝光 ${seen.length} 次；补充解释、例子或未解问题`,
      };
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.collection_id.localeCompare(b.collection_id),
    );
  const seen = new Set();
  const revisit = groups.filter((g) => {
    if (seen.has(g.evidence_key)) return false;
    seen.add(g.evidence_key);
    return true;
  });
  const available = {
    deep: open.length > 0,
    revisit: revisit.length > 0,
    discover: true,
  };
  const allowed = paths.filter((p) => available[p] && cfg.ratios[p] > 0);
  if (!allowed.length)
    throw Error(
      "No available exploration path with a positive ratio; add questions or change ratios",
    );
  const total = allowed.reduce((n, p) => n + cfg.ratios[p], 0);
  // Deficits compensate actual exposure, while seeded weighted sampling permits consecutive deep dives.
  const weights = Object.fromEntries(
    allowed.map((p) => [
      p,
      Math.max(0, (cfg.ratios[p] / total) * (recent.length + 1) - counts[p]),
    ]),
  );
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  const draw =
    parseInt(
      hash([
        input.seed,
        input.subject,
        input.scene,
        cfg,
        counts,
        available,
        "exploration-v1",
      ]).slice(0, 12),
      16,
    ) / 0x1000000000000;
  let cursor = draw * sum,
    path = allowed.at(-1);
  for (const p of allowed) {
    cursor -= weights[p];
    if (cursor < 0) {
      path = p;
      break;
    }
  }
  return {
    algorithm: "exploration-v1",
    state_version: hash(s),
    subject: input.subject,
    scene: input.scene,
    seed: input.seed,
    path,
    config: structuredClone(cfg),
    counts,
    weights,
    available,
    unavailable: paths.filter((p) => !available[p]),
    reason: `选择 ${path}：目标比例 ${Math.round(cfg.ratios[path] * 100)}%，最近 ${recent.length} 次实际曝光中占 ${counts[path]} 次，当前欠额 ${weights[path].toFixed(3)}；不可用路径暂时排除，零比例路径不参与`,
    questions: open.slice(0, input.limit),
    revisit: revisit.slice(0, input.limit),
    discovery: {
      adjacent:
        "检索当前内容中的陌生术语、前置概念、参考来源及争议，再携原文提交 concept_propose",
      distant: "另检索近期少见领域的真实内容，避免新词全部来自当前领域",
      rule: "先记录带来源的 pending 候选，解释、比较后再评估；发现不代表理解或喜欢",
    },
  };
}
export function validateExploration(s, input, now) {
  if (!input.exploration) {
    if (input.options.some((o) => o.target))
      throw Error("Exploration targets require an exploration plan");
    return null;
  }
  const x = input.exploration;
  if (x.state_version !== hash(s))
    throw Error("Exploration state conflict; plan again");
  const plan = explorationPlan(s, { ...input, seed: x.seed, limit: 50 }, now);
  if (plan.path !== x.path) throw Error("Exploration path does not match plan");
  for (const o of input.options) {
    if (!o.eligible) continue;
    const t = o.target;
    if (!t) throw Error("Exploration options require targets");
    if (x.path === "deep") {
      const q = s.exploration?.questions?.[t.question_id];
      if (
        !q ||
        q.status !== "active" ||
        q.subject !== input.subject ||
        q.scene !== input.scene
      )
        throw Error(
          "Deep exploration needs an active question in the same subject and scene",
        );
      validGroup(s, q.collection_id, input.subject, input.scene);
      if (t.collection_id !== q.collection_id || t.candidate_id)
        throw Error("Deep target must match the question collection");
    } else if (x.path === "revisit") {
      validGroup(s, t.collection_id, input.subject, input.scene);
      if (t.question_id || t.candidate_id)
        throw Error("Revisit target must name only a collection");
    } else {
      const m = s.members[t.candidate_id];
      if (
        !m ||
        m.status !== "pending" ||
        m.subject !== input.subject ||
        (m.scene !== "general" && m.scene !== input.scene) ||
        !s.sources[m.source_id]
      )
        throw Error(
          "Discovery needs a sourced pending candidate in the same subject and scene",
        );
      if (t.collection_id || t.question_id)
        throw Error("Discovery target must name only a pending candidate");
    }
    if (
      x.path !== "discover" &&
      !o.contributions.some((c) => c.collection_id === t.collection_id)
    )
      throw Error(
        "Exploration target needs contribution evidence from its collection",
      );
    if (
      o.contributions.some(
        (c) => c.collection_id !== t.collection_id && c.purpose !== "stance",
      )
    )
      throw Error(
        "Exploration contributions must belong to the target collection",
      );
  }
  return { ...plan, reason: x.reason, planner_reason: plan.reason };
}
export function mutateExploration(s, name, input, now, emit, links) {
  const state = (s.exploration ??= {
    config: structuredClone(EXPLORATION_DEFAULTS),
    questions: {},
  });
  if (name === "exploration_configure") {
    const before = state.config;
    state.config = {
      algorithm: "exploration-v1",
      ratios: input.ratios,
      history_window: input.history_window,
    };
    const result = {
      before,
      after: state.config,
      reason: input.reason,
      at: now,
    };
    emit("exploration.configured", result, links);
    return result;
  }
  if (name === "exploration_question") {
    validGroup(s, input.collection_id, input.subject, input.scene);
    checkSources(s, input.source_ids);
    const previous = input.question_id
      ? state.questions[input.question_id]
      : null;
    if (input.question_id && !previous)
      throw Error("Unknown exploration question");
    if (
      previous &&
      (previous.subject !== input.subject ||
        previous.scene !== input.scene ||
        previous.collection_id !== input.collection_id)
    )
      throw Error("Question subject, scene and collection cannot change");
    const id = input.question_id ?? crypto.randomUUID();
    const { key, trace_id, question_id, ...fields } = input;
    const result = {
      ...previous,
      ...fields,
      id,
      created_at: previous?.created_at ?? now,
      updated_at: now,
    };
    state.questions[id] = result;
    emit("exploration.question_updated", result, links);
    return result;
  }
  if (name === "exploration_progress") {
    const d = s.decisions[input.decision_id];
    if (!d?.exploration)
      throw Error("Progress needs a committed exploration decision");
    if (d.exploration.progress)
      throw Error(
        "Exploration progress already recorded; use the original idempotency key",
      );
    if (input.trace_id && input.trace_id !== d.trace_id)
      throw Error("Progress trace does not match decision");
    checkSources(s, input.source_ids);
    const engaged = ["engaged", "completed"].includes(input.outcome);
    if(engaged&&d.feed_judgment?.read_policy==='subtitle-pages-v1') {
      const exposure=d.exploration.exposure
      if(exposure?.scope!=='subtitle_pages_presented_not_watch_completion')throw Error('Read all subtitle pages before exploration progress')
      if(!input.source_ids.length||input.source_ids.some(id=>!exposure.source_ids.includes(id)))throw Error('Progress must cite this decision actual subtitle read')
      if(!input.answered||!input.next_step)throw Error('Actual reading progress needs an answer and next step')
    }
    if (engaged && !input.source_ids.length)
      throw Error("Actual exposure needs recorded source evidence");
    if (
      !engaged &&
      (input.answered ||
        input.remaining ||
        input.next_step ||
        input.question_status)
    )
      throw Error(
        "Skipped or failed exploration cannot report question progress",
      );
    const q = state.questions[d.exploration.target.question_id];
    if (input.question_status && !q)
      throw Error("Question status needs a question target");
    if (
      q &&
      engaged &&
      ((!input.remaining && input.question_status !== "resolved") ||
        !input.next_step)
    )
      throw Error(
        "Question progress needs remaining questions and a next step (resolved may omit remaining)",
      );
    const { key, ...fields } = input;
    const result = { ...fields, at: now, attribution: "caller_reported" };
    d.exploration.progress = result;
    if (q && engaged) {
      q.answered = input.answered;
      q.remaining = input.remaining;
      q.next_step = input.next_step;
      q.status = input.question_status ?? q.status;
      q.updated_at = now;
      q.last_decision_id = d.id;
      q.source_ids = [...new Set([...q.source_ids, ...input.source_ids])];
    }
    emit("exploration.progress_recorded", result, {
      ...links,
      trace_id: d.trace_id,
      decision_id: d.id,
    });
    return result;
  }
  throw Error("Unsupported exploration operation");
}

import { hash } from "./store.mjs";
import { collectionStrength } from "./engine.mjs";
import { explorationPlan } from "./exploration.mjs";

export const FEED_RELEVANCE_POLICY = Object.freeze({
  algorithm: "feed-relevance-v1",
  min_relevance: 0.5,
});
const assessmentInstructions =
  "先判断候选是否有助于当前探索目标：relevance=0 表示无关或仅碰巧命中同名词，0到0.5以下表示弱关联、不足以入选，0.5到1表示有材料支持的相关候选。deep 的前置知识、反例与争议也可相关，不要求先证明结论；discover 针对陌生领域的学习价值判断，不要求命中旧兴趣。无合适内容可全给0，清单可短于n或为空。立场 strength 是该立场对【选择阅读这条视频】的支持方向：建议读为正，建议跳过为负，无关为0；不是材料与立场的一致度，也不是确信程度。“克制所以跳过”应为负，不能因完成评估流程而加分。";

function automaticContinuation(state,run_id) {
  const cycle=Object.values(state.auto_exploration_cycles??{}).find(c=>run_id===`${c.id}-r${c.round}`)
  return cycle?{next:`调用 exploration_next({cycle_id:"${cycle.id}"})，由状态机执行检索与恢复；不要直接调用 feed_run。`,next_action:'exploration_next',arguments:{cycle_id:cycle.id}}:{}
}
export function stanceMembers(state) {
  if (!state) return [];
  return Object.values(state.collections)
    .filter((c) => c.subject === "fish")
    .flatMap((c) =>
      c.members.map((id) => ({ collection: c, member: state.members[id] })),
    )
    .filter(
      ({ member: m }) =>
        m?.subject === "fish" &&
        m.status === "accepted" &&
        m.tags.includes("belief") &&
        m.interpretation === "explicit" &&
        ["general", "watch"].includes(m.scene),
    )
    .sort(
      (a, b) =>
        collectionStrength(b.collection, state) -
          collectionStrength(a.collection, state) ||
        a.member.id.localeCompare(b.member.id),
    )
    .filter(
      (x, i, all) => all.findIndex((y) => y.member.id === x.member.id) === i,
    )
    .slice(0, 8);
}
export const candidateText = (v) => `${v.t}\n${v.description ?? ""}`;
export function explorationForFeed(state, seed, now) {
  if (!state?.exploration && !stanceMembers(state).length) return null;
  const plan = explorationPlan(
    state,
    { subject: "fish", scene: "watch", seed: seed + ":exploration", limit: 50 },
    now,
  );
  let target = null;
  if (plan.path === "deep") {
    const q = plan.questions[0];
    target = { collection_id: q.collection_id, question_id: q.id };
  }
  if (plan.path === "revisit")
    target = { collection_id: plan.revisit[0].collection_id };
  return { ...plan, target };
}
const fingerprint = (selector, args) =>
  hash({
    ...args,
    seed: selector.seed,
    mode: selector.mode,
    request: selector.request,
  });
function needsReview(selector, state) {
  return (
    selector.mode === "active" &&
    (state?.exploration || stanceMembers(state).length)
  );
}
export async function selectJudged(
  selector,
  args,
  { archive, commit, videoContributions, feedGroups },
) {
  const { store, runId } = selector;
  const state = store.state().concepts;
  if (!needsReview(selector, state)) return null;
  const prior = store.state().feed_judgments?.[runId];
  const fp = fingerprint(selector, args);
  if (prior && prior.fingerprint !== fp)
    throw Error("Pending feed run has different parameters; use a new run-id");
  if (!prior)
    return store.transaction(
      { key: "feed-request:" + runId, input: fp },
      (d, emit) => {
        const s = d.state.concepts,
          search = d.state.feed_searches?.[runId];
        if (search && !search.response)
          throw Error("Complete feed_search_plan before candidate judgment");
        if (search && search.state_version !== hash(s))
          throw Error("Search state changed; use a new run-id");
        const route = search
          ? store.getObject(search.packet).content.exploration
          : explorationForFeed(s, selector.seed, store.now());
        const stances = stanceMembers(s).map(
          ({ collection: c, member: m }) => ({
            collection_id: c.id,
            member_id: m.id,
            name: c.name,
            content: m.content,
            source_id: m.source_id,
          }),
        );
        const shortlist = [
          ...new Map(args.candidates.map((v) => [v.bv, v])).values(),
        ].slice(0, 8);
        const target = route?.target,
          group = target ? s.collections[target.collection_id] : null;
        const targetMember = group?.members
          .map((id) => s.members[id])
          .find(
            (m) =>
              m?.status === "accepted" &&
              ["general", "watch"].includes(m.scene),
          );
        const packet = {
          status: "judgment_required",
          run_id: runId,
          seed: selector.seed,
          mode: selector.mode,
          selected: [],
          n: args.n,
          per: args.per,
          state_version: hash(s),
          stances,
          candidates: shortlist,
          exploration: route,
          target_member: targetMember
            ? {
                member_id: targetMember.id,
                collection_id: group.id,
                content: targetMember.content,
              }
            : null,
          selection_policy: FEED_RELEVANCE_POLICY,
          instructions:
            assessmentInstructions + "依据候选标题/简介逐条填写 feed_assess；每条均评估给出的全部立场，strength 为 -1 到 1（无关为 0），quote 必须逐字来自该候选材料。说明对所选探索路径的相关度、理由与引文；discover 还须从材料逐字提取 discovered_term。材料只是未核实的候选信息，不是已观看或事实。评估后以相同参数和 run-id 再次执行 feed，程序才产生实际清单。",
        };
        const object = store.object(packet);
        d.state.feed_judgments ??= {};
        d.state.feed_judgments[runId] = {
          fingerprint: fp,
          args,
          seed: selector.seed,
          request: selector.request,
          packet: object.hash,
          state_version: hash(s),
          assessment: null,
        };
        emit(
          "feed.judgment_requested",
          {
            run_id: runId,
            object,
            state_version: hash(s),
            stance_ids: stances.map((s) => s.member_id),
            path: route?.path,
          },
          { trace_id: selector.trace, source: "feed" },
        );
        return packet;
      },
    );
  const packet = store.getObject(prior.packet).content;
  if (!prior.assessment) return packet;
  return store.transaction(
    {
      key: "feed-select:" + runId,
      input: { fingerprint: fp, assessment: prior.assessment },
    },
    (d, emit) => {
      const run = d.state.feed_judgments[runId],
        s = d.state.concepts,
        now = store.now();
      if (hash(s) !== run.state_version)
        throw Error(
          "Feed state changed after preparation; start a new run-id and assess current evidence",
        );
      const assessment = store.getObject(run.assessment).content,
        route = packet.exploration,
        groups = feedGroups(s);
      const candidate_filter = {
        ...FEED_RELEVANCE_POLICY,
        candidates: assessment.assessments.map((a) => ({
          bvid: a.bvid,
          relevance: a.exploration.relevance,
          eligible: a.exploration.relevance >= FEED_RELEVANCE_POLICY.min_relevance,
          reason: a.exploration.relevance >= FEED_RELEVANCE_POLICY.min_relevance
            ? "meets_exploration_relevance"
            : "below_exploration_relevance",
          assessment_reason: a.exploration.reason,
          quote: a.exploration.quote,
        })),
      };
      emit("feed.candidates_filtered", {run_id: runId, ...candidate_filter}, {
        trace_id: selector.trace, source: "feed",
      });
      const remaining = assessment.assessments
        .filter((a) => a.exploration.relevance >= FEED_RELEVANCE_POLICY.min_relevance)
        .map((a) => ({ a, v: packet.candidates.find((v) => v.bv === a.bvid) }));
      const selected = [],
        decisions = [],
        used = new Map();
      while (remaining.length && selected.length < args.n) {
        const options = remaining
          .filter(({ v }) => (used.get(v.up) ?? 0) < args.per)
          .map(({ a, v }) => {
            const contributions = a.stances
              .filter((x) => x.strength !== 0)
              .map((x) => ({
                ...x,
                relevance: a.exploration.relevance,
                purpose: "stance",
                reason: `${x.reason}；候选原文：${x.quote}`,
              }))
              .map(({ quote, ...c }) => c);
            let target = route?.target;
            if (route?.path === "discover") {
              const source_id =
                "feed-source-" +
                hash([runId, v.bv, candidateText(v)]).slice(0, 24);
              if (!s.sources[source_id]) {
                s.sources[source_id] = {
                  id: source_id,
                  actor: "third_party",
                  type: "manual",
                  ref: `bili:${v.bv}#metadata`,
                  excerpt: candidateText(v),
                  scope: "candidate_metadata_not_viewed",
                };
                emit(
                  "source.observed",
                  { source: s.sources[source_id] },
                  { trace_id: selector.trace, source: "feed" },
                );
              }
              const id =
                "item-" +
                hash([source_id, "fish", a.discovered_term]).slice(0, 24);
              if (!s.members[id]) {
                s.members[id] = {
                  id,
                  subject: "fish",
                  content: a.discovered_term,
                  source_id,
                  tags: ["topic"],
                  scene: "general",
                  triggers: [],
                  exclusions: [],
                  interpretation: "mention",
                  status: "pending",
                  proposed_at: now,
                };
                emit("candidate.proposed", s.members[id], {
                  trace_id: selector.trace,
                  source: "feed",
                });
              }
              target = { candidate_id: id };
            } else if (target) {
              contributions.push({
                collection_id: target.collection_id,
                member_id: packet.target_member.member_id,
                relevance: a.exploration.relevance,
                strength: 1,
                purpose: "exploration",
                reason: `${a.exploration.reason}；候选原文：${a.exploration.quote}`,
              });
            } else contributions.push(...videoContributions(v, groups));
            return {
              label: v.bv,
              eligible: true,
              reason: a.exploration.reason,
              target,
              contributions,
            };
          });
        if (!options.length) break;
        // Discovery candidate capture above changes state: validate the same path against the current state version.
        const input = {
          feed_judgment: {
            policy: "stance-prior-v1",
            read_policy:"subtitle-pages-v1",
            run_id: runId,
            assessment_object: run.assessment,
            material_scope: "candidate_metadata",
            stance_ids: packet.stances.map((x) => x.member_id),
            relevance_policy: FEED_RELEVANCE_POLICY,
          },
          question: `feed 阅读清单第 ${selected.length + 1} 条：依据立场与探索目标选择`,
          scene: "watch",
          subject: "fish",
          trace_id: selector.trace,
          seed: `${selector.seed}:judged:${selected.length}`,
          options,
          ...(route
            ? {
                exploration: {
                  path: route.path,
                  seed: route.seed,
                  state_version: hash(s),
                  reason:
                    "feed 实际采用配置的探索路径，并由当前模型引用候选材料进行立场判断",
                },
              }
            : {}),
        };
        const preview = archive(store, d, emit, s, input, now),
          winner = remaining.find((x) => x.v.bv === preview.result.winner);
        selected.push(winner.v);
        used.set(winner.v.up, (used.get(winner.v.up) ?? 0) + 1);
        const decision = commit(store, d, emit, s, preview, now);
        decisions.push(decision);
        remaining.splice(remaining.indexOf(winner), 1);
      }
      const result = {
        status: "selected",
        selected,
        proposed: selected,
        mode: selector.mode,
        run_id: runId,
        seed: selector.seed,
        trace_id: selector.trace,
        decisions,
        n: args.n,
        per: args.per,
        request: selector.request,
        candidate_count: args.candidates.length,
        assessment_object: run.assessment,
        exploration_path: route?.path ?? null,
        policy: "feed-judged-v1",
        candidate_filter,
        fallback: selected.length ? null : "no_suitable_assessed_candidates",
      };
      emit(
        "feed.selected",
        { ...result, selection_scope: "reading_slate_not_viewed" },
        { trace_id: selector.trace, source: "feed" },
      );
      return result;
    },
  );
}
export async function assessFeed(store, input) {
  return store.transaction(
    { key: "feed-assess:" + input.key, input },
    (d, emit) => {
      const run = d.state.feed_judgments?.[input.run_id];
      if (!run) throw Error("Unknown prepared feed run");
      if (run.assessment)
        throw Error(
          "Feed run already assessed; retry the original idempotency key",
        );
      if (hash(d.state.concepts) !== run.state_version)
        throw Error("Feed state changed; prepare a new run-id");
      const p = store.getObject(run.packet).content,
        seen = new Set();
      const automatic=!!automaticContinuation(d.state,input.run_id).next_action;
      if (input.assessments.length !== p.candidates.length && !(automatic&&input.assessments.length===1))
        throw Error("Assess every prepared candidate exactly once");
      for (const a of input.assessments) {
        const v = p.candidates.find((v) => v.bv === a.bvid);
        if (!v || seen.has(a.bvid))
          throw Error("Unknown or duplicate assessed video");
        seen.add(a.bvid);
        const text = candidateText(v),
          ids = new Set();
        if (!text.includes(a.exploration.quote))
          throw Error("Exploration quote is not in candidate material");
        if (a.stances.length !== p.stances.length)
          throw Error(`Assess every supplied stance, including neutral ones for ${a.bvid}; expected ${p.stances.map(s=>s.name+":"+s.member_id).join(", ")}`);
        for (const x of a.stances) {
          if (
            ids.has(x.member_id) ||
            !p.stances.some(
              (s) =>
                s.member_id === x.member_id &&
                s.collection_id === x.collection_id,
            )
          )
            throw Error("Unknown or duplicate stance");
          ids.add(x.member_id);
          if (!text.includes(x.quote))
            throw Error(`Stance quote is not in candidate material: ${a.bvid}/${x.member_id}; neutral items may quote the exact candidate title`);
        }
        if (p.exploration?.path === "discover" && a.exploration.relevance >= FEED_RELEVANCE_POLICY.min_relevance) {
          if (!a.discovered_term || !text.includes(a.discovered_term))
            throw Error("Discovery needs a term quoted from actual material");
          if (
            Object.values(d.state.concepts.members).some(
              (m) =>
                m.subject === "fish" &&
                m.status === "accepted" &&
                m.content.normalize("NFKC").toLowerCase() ===
                  a.discovered_term.normalize("NFKC").toLowerCase(),
            )
          )
            throw Error(
              "Discovery term is already accepted; choose a genuinely unfamiliar term or mark the candidate unsuitable",
            );
        }
      }
      let assessments=input.assessments;
      if(automatic) {
        run.candidate_assessments??={};
        for(const assessment of input.assessments) {
          const existing=run.candidate_assessments[assessment.bvid];
          if(existing&&store.getObject(existing).content.assessment.bvid===assessment.bvid&&hash(store.getObject(existing).content.assessment)!==hash(assessment))throw Error('Candidate already assessed; resume the cycle or start a new cycle')
          if(!existing){const saved=store.object({assessment,at:store.now(),state_version:run.state_version});run.candidate_assessments[assessment.bvid]=saved.hash;emit('feed.candidate_assessed',{run_id:input.run_id,bvid:assessment.bvid,object:saved},{trace_id:'feed-'+hash(input.run_id).slice(0,32),source:'feed'})}
        }
        if(Object.keys(run.candidate_assessments).length<p.candidates.length)return {run_id:input.run_id,status:'partially_assessed',assessed:Object.keys(run.candidate_assessments).length,total:p.candidates.length,...automaticContinuation(d.state,input.run_id)};
        assessments=p.candidates.map(v=>store.getObject(run.candidate_assessments[v.bv]).content.assessment);
      }
      const object = store.object({
        ...input,
        assessments,
        at: store.now(),
        attribution: "caller_reported_judgment",
        material_scope: "candidate_metadata_not_content_verification",
      });
      run.assessment = object.hash;
      emit(
        "feed.judgment_recorded",
        {
          run_id: input.run_id,
          object,
          stance_ids: p.stances.map((s) => s.member_id),
          path: p.exploration?.path,
        },
        { trace_id: "feed-" + hash(input.run_id).slice(0, 32), source: "feed" },
      );
      return {
        run_id: input.run_id,
        status: "assessed",
        assessment_object: object.hash,
        next: "重新执行 feed，沿用原 run-id 与参数；程序将实际算分并选入阅读清单",
        ...automaticContinuation(d.state,input.run_id),
      };
    },
  );
}

export async function planSearch(selector, legacyKeywords) {
  const { store, runId } = selector,
    s = store.state().concepts;
  if (!needsReview(selector, s)) return null;
  const input = {
    seed: selector.seed,
    request: selector.request,
    mode: selector.mode,
    legacyKeywords,
  };
  const existing = store.state().feed_searches?.[runId];
  if (existing && existing.fingerprint !== hash(input))
    throw Error("Search run parameters changed; use a new run-id");
  if (!existing)
    return store.transaction(
      { key: "feed-plan-request:" + runId, input },
      (d, emit) => {
        const state = d.state.concepts,
          route = explorationForFeed(state, selector.seed, store.now()),
          target = route.target;
        const packet = {
          status: "search_plan_required",
          run_id: runId,
          seed: selector.seed,
          state_version: hash(state),
          exploration: route,
          target: target
            ? {
                ...target,
                name: state.collections[target.collection_id].name,
                members: state.collections[target.collection_id].members
                  .map((id) => state.members[id])
                  .filter((m) => m.status === "accepted")
                  .map((m) => ({ id: m.id, content: m.content, tags: m.tags })),
                question: target.question_id
                  ? state.exploration.questions[target.question_id]
                  : null,
              }
            : null,
          stances: stanceMembers(state).map(({ collection: c, member: m }) => ({
            collection_id: c.id,
            member_id: m.id,
            content: m.content,
            name: c.name,
          })),
          instructions:
            "调用 feed_search_plan 提出1至4条短查询词与理由。deep 围绕该未解问题补前置知识、反例和争议；revisit 针对该稀疏群补解释或应用实例，若其是立场则提出可检验的问题，不把立场声明当作事实或直接话题；discover 主动查当前概念图之外的陌生术语或领域。随后原参数重跑 feed 执行真实搜索，再按 judgment_required 调用 feed_assess 并恢复清单。",
        };
        const object = store.object(packet);
        d.state.feed_searches ??= {};
        d.state.feed_searches[runId] = {
          fingerprint: hash(input),
          packet: object.hash,
          state_version: hash(state),
          response: null,
          legacyKeywords,
        };
        emit(
          "feed.exploration_planned",
          {
            run_id: runId,
            object,
            path: route.path,
            target,
            config: route.config,
          },
          { trace_id: selector.trace, source: "feed" },
        );
        return packet;
      },
    );
  const packet = store.getObject(existing.packet).content;
  if (!existing.response) return packet;
  if (hash(s) !== existing.state_version)
    throw Error("Search evidence state changed; use a new run-id");
  return store.transaction({ key: "feed-plan:" + runId, input }, (d, emit) => {
    const response = store.getObject(existing.response).content;
    const keywords = [
      ...new Set([...response.queries, ...legacyKeywords]),
    ].slice(0, 6);
    const result = {
      status: "search_ready",
      keywords,
      proposed: response.queries,
      mode: selector.mode,
      run_id: runId,
      seed: selector.seed,
      exploration: packet.exploration,
      reason: response.reason,
      query_object: existing.response,
    };
    emit("feed.search_planned", result, {
      trace_id: selector.trace,
      source: "feed",
    });
    return result;
  });
}
export async function assessSearch(store, input) {
  return store.transaction(
    { key: "feed-search-assess:" + input.key, input },
    (d, emit) => {
      const run = d.state.feed_searches?.[input.run_id];
      if (!run) throw Error("Unknown exploration search request");
      if (run.response)
        throw Error("Search already planned; retry original idempotency key");
      if (run.state_version !== hash(d.state.concepts))
        throw Error("Search state changed; use a new run-id");
      if (
        new Set(input.queries.map((s) => s.normalize("NFKC").toLowerCase()))
          .size !== input.queries.length
      )
        throw Error("Duplicate search query");
      const packet = store.getObject(run.packet).content;
      const object = store.object({
        ...input,
        at: store.now(),
        path: packet.exploration.path,
        target: packet.exploration.target,
        attribution: "caller_planned_queries_not_accepted_concepts",
      });
      run.response = object.hash;
      emit(
        "feed.search_assessed",
        {
          run_id: input.run_id,
          object,
          path: packet.exploration.path,
          queries: input.queries,
        },
        { trace_id: "feed-" + hash(input.run_id).slice(0, 32), source: "feed" },
      );
      return {
        run_id: input.run_id,
        status: "search_ready",
        next: "以相同参数和 run-id 再次执行 feed，真实检索这些查询词。",
        ...automaticContinuation(d.state,input.run_id),
      };
    },
  );
}

// Business responses carry the current task; archived packets retain the audit.
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const routeKeys = ['algorithm', 'state_version', 'seed', 'path', 'reason', 'target'];
const questionKeys = ['id', 'question', 'remaining', 'next_step', 'source_ids', 'status'];
export const detailSections = ['interest_competition', 'member_competitions', 'questions', 'revisit', 'target_members', 'stances', 'candidates'];

export function compactFeed(packet) {
  if (packet?.status === 'search_ready' || (packet?.keywords && !packet?.selected)) return {...pick(packet, ['status', 'run_id', 'seed', 'keywords', 'keyword_sources', 'proposed', 'mode', 'reason', 'query_object']), exploration:pick(packet.exploration, routeKeys)};
  if (packet?.status === 'selected' || (packet?.selected && packet?.decisions)) {
    return {...pick(packet, ['status', 'selected', 'mode', 'run_id', 'seed', 'trace_id', 'n', 'per', 'candidate_count', 'exploration_path', 'policy', 'candidate_filter', 'fallback']),
      decisions:packet.decisions.map(d=>pick(d, ['id', 'preview_id', 'selected', 'trace_id', 'shadow'])),
      ...(packet.search ? {search:compactFeed(packet.search)} : {}),
      ...(packet.mode === 'shadow' ? {proposed:packet.proposed} : {}),
      ...(packet.trace_id ? {details:{tool:'trace_get',arguments:{trace_id:packet.trace_id},instructions:'按事件读取完整选择依据与证据对象。'}} : {})};
  }
  if (!['search_plan_required', 'judgment_required'].includes(packet?.status)) return packet;
  const result = pick(packet, ['status', 'run_id', 'seed', 'mode', 'n', 'per', 'state_version', 'selected', 'stances', 'candidates', 'target_member', 'selection_policy', 'instructions', 'assessment_progress']);
  const route = packet.exploration;
  result.exploration = pick(route, routeKeys);
  if (route?.path === 'discover') result.exploration.discovery = route.discovery;
  const question = packet.target?.question ?? route?.question ?? route?.questions?.find(q => q.id === route.target?.question_id);
  if (packet.target) {
    result.target = pick(packet.target, ['collection_id', 'question_id', 'name']);
    // Representative labels suffice for planning; full members remain queryable.
    const members = packet.target.members ?? [];
    result.target.members = members.slice(0, 3).map(m => ({...pick(m, ['id', 'tags', 'keywords']), content: m.content.slice(0, 240), ...((m.content_truncated || m.content.length > 240) ? {content_truncated:true} : {})}));
    result.target.member_count = packet.target.member_count ?? members.length;
  }
  if (question) result.exploration.question = pick(question, questionKeys);
  if (packet.interests) result.interests = pick(packet.interests, ['keywords', 'keyword_sources']);
  result.details = {tool:'feed_details', arguments:{run_id:packet.run_id, stage:packet.status === 'search_plan_required' ? 'search' : 'judgment'}, sections:detailSections, instructions:'仅在需要更多依据时按 section 分页查询；评分已由程序完成，无需重新计算。'};
  return result;
}

// Read only: resolve the packet of this exact run, never recompute a plan.
export function feedDetails(store, {run_id, stage='search', section, offset=0, limit=5, competition_index=0}) {
  const state = store.state();
  const run = (stage === 'search' ? state.feed_searches : state.feed_judgments)?.[run_id];
  if (!run) throw Error('No archived '+stage+' packet for this run_id');
  const packet = store.getObject(run.packet).content;
  let items, metadata = {};
  if (section === 'interest_competition' || section === 'member_competitions') {
    const competitions = section === 'interest_competition' ? [packet.interests?.competition].filter(Boolean) : packet.interests?.member_competitions ?? [];
    const competition = competitions[competition_index];
    if (!competition && competitions.length) throw Error('Competition index out of range');
    metadata = {...pick(competition, ['algorithm', 'parameters', 'at', 'winner', 'state_version']), competition_count:competitions.length, competition_index};
    items = competition?.rows ?? [];
  } else {
    items = {questions:packet.exploration?.questions, revisit:packet.exploration?.revisit, target_members:packet.target?.members, stances:packet.stances, candidates:packet.candidates}[section] ?? [];
  }
  const next = offset + limit < items.length ? offset + limit : null;
  return {run_id, stage, section, packet_hash:run.packet, ...metadata, total:items.length, offset, items:items.slice(offset, offset+limit), next_offset:next, ...(next !== null ? {continue_with:{tool:'feed_details',arguments:{run_id,stage,section,offset:next,limit,competition_index}}} : {})};
}

import fs from 'node:fs'
import { dshPath } from '../paths.mjs'
import { readingBudget } from './exploration-budget.mjs'

const scheduled = id => /^night-[0-9a-f]{24}$/.test(id)

export function savedFishSession() {
  try {
    const {id} = JSON.parse(fs.readFileSync(dshPath('whale-session.json'), 'utf8'))
    return typeof id === 'string' && id ? id : null
  } catch { return null }
}

function interrupt(cycle, web, reason, emit) {
  if (web) web.phase = 'closed'
  cycle.status = 'interrupted'
  cycle.result = {cycle_id:cycle.id, status:cycle.status, next_action:'stop',
    round:cycle.round, reason, stop_reason:'session_context_lost', last_step:cycle.checkpoint ?? null,
    readings:cycle.completed_reads ?? [], reading_budget:readingBudget(cycle)}
  emit('exploration.cycle_interrupted', cycle.result, {source:'automatic_exploration'})
}

// Called inside the transaction that creates a wake. Replaying a wake returns
// the same cycle even after its resumed work has finished.
export function resolveWake(d, emit, requested, sessionId) {
  const cycles = d.state.auto_exploration_cycles ??= {}
  const values = Object.values(cycles)
  const existing = Object.hasOwn(cycles, requested) ? cycles[requested] : values.find(c => c.resumed_by?.includes(requested))
  if (existing) {
    if (existing.status === 'active' && scheduled(existing.id) && sessionId && existing.session_id && existing.session_id !== sessionId) {
      interrupt(existing, d.state.web_runs?.[existing.id + '-r' + existing.round], '原阅读会话已轮换', emit)
    }
    return existing
  }
  const resumable = []
  for (const cycle of values.filter(c => c.status === 'active')) {
    const run = cycle.id + '-r' + cycle.round
    const reads = d.reads.forRun(run)
    const audio = reads.find(r => r.audio_draft && (r.status === 'audio_pending' || (!r.session_id && r.status !== 'failed')))
    const regular = scheduled(requested) && scheduled(cycle.id)
    if (!regular && !audio) continue
    const web = d.state.web_runs?.[run]
    const owner = web?.session_id || reads.find(r => r.session_id)?.session_id || cycle.session_id
    if (!cycle.checkpoint) {
      const read = reads[0] ?? d.state.resource_reads?.[web?.read_ids?.at(-1)]
      const stage = read?.reading_complete ? 'reading_complete' : read?.status ?? web?.phase ??
        (d.state.feed_judgments?.[run] ? 'candidate_judgment' : d.state.feed_searches?.[run] ? 'search_plan' : 'round_started')
      cycle.checkpoint = {round:cycle.round, status:stage, read_id:read?.id ?? null}
    }
    if ((audio && !owner) || (regular && sessionId && owner === sessionId)) {
      resumable.push({cycle, audio:Boolean(audio)})
    } else if (regular && sessionId) {
      interrupt(cycle, web, owner ? '原阅读会话已轮换' : '旧周期缺少可确认的会话归属', emit)
    }
  }
  resumable.sort((a,b) => Number(b.audio) - Number(a.audio) || b.cycle.started_at - a.cycle.started_at)
  const cycle = resumable[0]?.cycle
  if (cycle) {
    cycle.session_id ??= sessionId
    cycle.resumed_by ??= []
    cycle.resumed_by.push(requested)
    emit('exploration.cycle_resumed', {cycle_id:cycle.id, wake_id:requested, last_step:cycle.checkpoint ?? null}, {session_id:sessionId})
  }
  return cycle
}

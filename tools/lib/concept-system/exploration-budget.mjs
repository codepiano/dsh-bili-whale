// A cycle is a bounded reading session, not one successful item. Keep the
// per-round slate size stable while completed readings reduce future rounds.
export const readingBudget = cycle => ({limit:cycle.n,completed:cycle.completed_reads?.length??0,remaining:Math.max(0,cycle.n-(cycle.completed_reads?.length??0))})

export function recordCompletedRead(store,cycle_id,read,decision,progress) {
  return store.transaction({},(d,emit)=>{
    const cycle=d.state.auto_exploration_cycles[cycle_id]
    cycle.completed_reads??=[]
    if(!cycle.completed_reads.some(r=>r.read_id===read.id||(read.bvid&&r.bvid===read.bvid)||(read.url&&r.url===read.url))) {
      const entry={read_id:read.id,decision_id:decision.id,...(read.url?{url:read.url}:{bvid:read.bvid}),path:decision.exploration.path,source_ids:decision.exploration.exposure?.source_ids??[],outcome:progress.outcome,round:cycle.round}
      cycle.completed_reads.push(entry)
      emit('exploration.read_completed',{cycle_id,...entry,reading_budget:readingBudget(cycle)},{decision_id:decision.id,trace_id:decision.trace_id??null})
    }
    return cycle
  })
}

export function settleExplorationCycle(d,emit,cycle_id,reason,stop_reason) {
  const cycle=d.state.auto_exploration_cycles[cycle_id]
  if(cycle.status!=='active'&&cycle.result)return cycle.result
  const readings=cycle.completed_reads??[],last=readings.at(-1)
  const result={cycle_id,run_id:`${cycle_id}-r${Math.min(cycle.round,cycle.max_rounds)}`,status:readings.length?'complete':'exhausted',next_action:'stop',round:Math.min(cycle.round,cycle.max_rounds),max_rounds:cycle.max_rounds,reason,stop_reason,reading_budget:readingBudget(cycle),readings,...(last?{...last,scope:'delivered_text_and_sourced_progress_not_whole_video_playback'}:{})}
  // The final round is the session's round; each entry retains its own round.
  result.round=Math.min(cycle.round,cycle.max_rounds)
  cycle.status=result.status;cycle.result=result
  emit(readings.length?'exploration.cycle_completed':'exploration.cycle_exhausted',result,{source:'automatic_exploration'})
  return result
}

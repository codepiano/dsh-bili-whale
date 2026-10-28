import {config} from '../config.mjs'
import {hash} from './store.mjs'
import {VideoReads,isVideoTextKind} from './video-reads.mjs'
import {runFeed} from './operations.mjs'

// Persistent orchestration is shared by every scheduled wake. The model supplies
// evidence-based judgments and reflections; it cannot mark a page as delivered.
export async function nextExploration(store,{cycle_id},{signal,feed=runFeed,readConfig=config}={}) {
  signal?.throwIfAborted()
  const cfgNow=readConfig()
  if(cfgNow.conceptSystem?.observe!==true||cfgNow.conceptSystem?.mode!=='active')return {status:'disabled',next_action:'legacy_feed',reason:'自动概念探索仅在 observe=true 且 active 时启用'}
  // A later scheduled wake resumes its unfinished paid task instead of selecting
  // another video and submitting another transcription.
  const prior=Object.values(store.state().auto_exploration_cycles??{}).find(c=>c.status==='active'&&store.journal.use(db=>!!db.prepare("SELECT id FROM video_reads WHERE status!='failed' AND json_extract(payload,'$.audio_draft.hash') IS NOT NULL AND json_extract(payload,'$.feed.run_id')=? LIMIT 1").get(`${c.id}-r${c.round}`)))
  if(prior&&prior.id!==cycle_id)return nextExploration(store,{cycle_id:prior.id},{signal,feed,readConfig})
  let cycle=await store.transaction({},(d,emit)=>{
    d.state.auto_exploration_cycles??={}
    if(d.state.auto_exploration_cycles[cycle_id])return d.state.auto_exploration_cycles[cycle_id]
    const cfg=readConfig(),n=Math.max(1,Math.min(20,Math.floor(Number(cfg.night?.maxVideos)||5)))
    const result={id:cycle_id,round:1,max_rounds:3,n,per:2,pool:30,source:'search',status:'active',started_at:store.now()}
    d.state.auto_exploration_cycles[cycle_id]=result
    emit('exploration.cycle_started',result,{source:'automatic_exploration'})
    return result
  })
  if(cycle.status!=='active')return cycle.result
  const run_id=`${cycle_id}-r${cycle.round}`,args={run_id,seed:run_id,n:cycle.n,per:cycle.per,pool:cycle.pool,source:cycle.source}
  const state=store.state(),pending=state.feed_judgments?.[run_id]??state.feed_searches?.[run_id]
  const committed=await store.transaction({state:false},d=>d.receipt('feed-select:'+run_id))
  if(!committed&&pending&&pending.state_version!==hash(state.concepts)) {
    await store.transaction({},(d,emit)=>{
      const current=d.state.auto_exploration_cycles[cycle_id]
      if(current.round===cycle.round){current.round++;emit('exploration.cycle_continued',{cycle_id,previous_run_id:run_id,round:current.round,reason:'concept_state_changed_before_selection'},{source:'automatic_exploration'})}
      if(current.round>current.max_rounds){current.status='exhausted';current.result={cycle_id,status:'exhausted',next_action:'stop',reason:'连续状态冲突，保留现场，下次作息继续'};emit('exploration.cycle_exhausted',current.result,{source:'automatic_exploration'})}
    })
    return nextExploration(store,{cycle_id},{signal,feed,readConfig})
  }
  const slate=await feed(args,{signal})
  const envelope={cycle_id,run_id,round:cycle.round,max_rounds:cycle.max_rounds,feed_arguments:args,continue_with:{tool:'exploration_next',arguments:{cycle_id}}}
  if(slate.status==='search_plan_required'||slate.status==='judgment_required') {
    const next_action=slate.status==='search_plan_required'?'feed_search_plan':'feed_assess'
    let packet=slate,required_arguments={run_id,key:run_id+':search'};
    if(next_action==='feed_assess') {
      const assessed=store.state().feed_judgments?.[run_id]?.candidate_assessments??{},candidate=slate.candidates.find(v=>!assessed[v.bv]);
      packet={...slate,candidates:candidate?[candidate]:[],assessment_progress:{assessed:Object.keys(assessed).length,total:slate.candidates.length}};
      required_arguments={run_id,key:run_id+':'+(candidate?.bv??'empty')};
    }
    const instructions=`只调用 ${next_action}，使用 required_arguments；候选判断每次只提交当前这一个候选，逐项覆盖 packet.stances 全部成员（无关也填0，引文可逐字使用候选标题）。非 discover 不填写 discovered_term。完成后调用 exploration_next({cycle_id:"${cycle_id}"})。不要直接调用 feed_run、猜测参数或排查源码；该 cycle 的全部检索参数由状态机保管。`
    const combinedInstructions=[packet.instructions,instructions].filter(Boolean).join('\n')
    return {...envelope,status:slate.status,next_action,required_arguments,packet:{...packet,instructions:combinedInstructions},instructions:combinedInstructions}
  }
  const rows=store.journal.use(db=>db.prepare("SELECT payload FROM video_reads WHERE json_extract(payload,'$.feed.run_id')=? ORDER BY rowid DESC").all(run_id).map(r=>JSON.parse(r.payload)))
  for(const video of slate.selected??[]) {
    const read=rows.find(r=>r.bvid===video.bv)
    if(!read)return {...envelope,status:'reading_required',next_action:'debrief_read',arguments:{bvid:video.bv,feed_run_id:run_id},reason:'字幕优先；缺字幕时尝试speech 服务云端音频转写，仍无正文再继续其他材料，不计曝光'}
    if(read.status==='audio_pending')return {...envelope,status:'audio_pending',next_action:'video_audio_status',arguments:{read_id:read.id},retry_after_seconds:30,instructions:'查询同一语音任务，不重新提交；pending 时至少30秒后再查，可结束本回合等下一次作息恢复。不得运行本地语音模型。'}
    if(read.status==='started') {
      if(store.now()-Date.parse(read.started_at)<480000)return {...envelope,status:'read_in_progress',next_action:'wait',read_id:read.id}
      await new VideoReads(store).fail(read.id,Error('Fixed debrief acquisition deadline expired; continue other material'))
      continue
    }
    if(!isVideoTextKind(read.kind)||read.status==='failed'||read.coverage?.truncated)continue
    if(!read.session_id&&read.audio_draft)return {...envelope,status:'awaiting_host_receipt',next_action:'video_audio_status',arguments:{read_id:read.id},reason:'重发原云端任务的已取得回执，不重新提交'}
    if(!read.session_id)return {...envelope,status:'awaiting_host_receipt',next_action:'wait',read_id:read.id}
    if(!read.reading_complete) {
      if(read.body_complete)return {...envelope,status:'awaiting_model_delivery',next_action:'wait',read_id:read.id,reason:'等待正常模型提供方接收确认，不提前计曝光'}
      const page=Array.from({length:read.sources.length},(_,i)=>i+1).find(p=>!read.pages_presented?.includes(p))
      return {...envelope,status:'body_required',next_action:'video_read_page',arguments:{read_id:read.id,page},total_pages:read.sources.length,coverage:read.coverage}
    }
    const decision=store.state().concepts?.decisions[read.feed.decision_id],progress=decision?.exploration?.progress
    if(!progress)return {...envelope,status:'progress_required',next_action:'exploration_progress',decision_id:read.feed.decision_id,read_id:read.id,source_ids:decision?.exploration?.exposure?.source_ids??[],target:decision?.exploration?.target,path:decision?.exploration?.path,instructions:'依据刚读完的字幕或音频转写写 answered、remaining、next_step；引用给定来源。有视觉疑问时先用 video_read_frames(read_id,times,reason) 补看相关时间点；需要核实口述时可用 debrief_read(audio=always) 经 speech 服务核实转写。未解决保持 active。revisit 在原集合下建立有来源的后续问题，然后再次调用 exploration_next。'}
    if(!['engaged','completed'].includes(progress.outcome))continue
    if(decision.exploration.path==='revisit') {
      const questions=Object.values(store.state().concepts.exploration.questions)
      const found=questions.find(q=>q.collection_id===decision.exploration.target.collection_id&&q.source_ids.some(id=>progress.source_ids.includes(id)))
      if(!found)return {...envelope,status:'question_required',next_action:'exploration_question',collection_id:decision.exploration.target.collection_id,source_ids:progress.source_ids,decision_id:decision.id,instructions:'根据实际正文和 remaining 建立可继续追问的问题，明确下一步和理由。'}
    }
    return store.transaction({},(d,emit)=>{
      const current=d.state.auto_exploration_cycles[cycle_id]
      const result={...envelope,status:'complete',next_action:'stop',decision_id:decision.id,read_id:read.id,bvid:read.bvid,path:decision.exploration.path,source_ids:progress.source_ids,scope:'full_text_pages_and_sourced_progress_not_whole_video_playback'}
      current.status='complete';current.result=result;current.completed_at=store.now()
      emit('exploration.cycle_completed',result,{decision_id:decision.id,trace_id:decision.trace_id})
      return result
    })
  }
  if(cycle.round>=cycle.max_rounds)return store.transaction({},(d,emit)=>{
    const result={...envelope,status:'exhausted',next_action:'stop',reason:'三轮实际清单仍无完整可读字幕或音频转写；保留失败历史，不生成曝光或虚构进展'}
    const current=d.state.auto_exploration_cycles[cycle_id];current.status='exhausted';current.result=result
    emit('exploration.cycle_exhausted',result,{source:'automatic_exploration'});return result
  })
  await store.transaction({},(d,emit)=>{
    const current=d.state.auto_exploration_cycles[cycle_id]
    if(current.round===cycle.round) {current.round++;emit('exploration.cycle_continued',{cycle_id,previous_run_id:run_id,round:current.round,reason:'本轮没有取得完整正文，继续实际搜索与选片，不把简介视为阅读'},{source:'automatic_exploration'})}
  })
  return nextExploration(store,{cycle_id},{signal,feed,readConfig})
}

import crypto from 'node:crypto'
import { ObservationStore, hash, redact } from './store.mjs'
import { scoreDecision, commitScoredDecision } from './engine.mjs'

const scene='feed'
const normalized=s=>String(s??'').normalize('NFKC').toLowerCase().trim()
const useful=s=>([...String(s)].length>=2||/^\p{Script=Han}$/u.test(String(s))) && [...String(s)].length<=24
export function feedGroups(state) {
  if(!state)return []
  return Object.values(state.collections).filter(c=>c.subject==='fish').map(c=>({
    collection:c,
    members:c.members.map(id=>state.members[id]).filter(m=>m?.status==='accepted'&&m.subject==='fish'&&
      m.tags.includes('topic')&&['explicit','mention'].includes(m.interpretation)&&['general',scene].includes(m.scene)),
  })).filter(g=>g.members.length).sort((a,b)=>a.collection.id.localeCompare(b.collection.id))
}
function termOf(m,c) {
  const clean=s=>String(s).replace(/[\r\n\t]/g,' ').trim()
  return [clean(m.content),clean(c.name)].find(useful)??null
}
function containsTerm(title,term) {
  const value=normalized(term)
  if(/^[a-z0-9 .+_-]+$/.test(value)) {
    const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(title)
  }
  return title.includes(value)
}
function contribution(g,m,relevance,reason) {
  return {collection_id:g.collection.id,member_id:m.id,relevance,
    strength:m.interpretation==='explicit'?1:0.7,reason}
}
export function interestPlan(state,seed,now,limit=4) {
  const groups=feedGroups(state).filter(g=>g.members.some(m=>termOf(m,g.collection)))
  if(!groups.length)return {keywords:[],competition:null,member_competitions:[]}
  const input={question:'今天检索哪些兴趣方向？这是搜索规划，尚未选择观看。',scene,subject:'fish',seed,
    options:groups.map(g=>({label:g.collection.id,eligible:true,reason:g.collection.name,
      contributions:g.members.filter(m=>termOf(m,g.collection)).sort((a,b)=>(a.interpretation==='explicit'?0:1)-(b.interpretation==='explicit'?0:1)||a.id.localeCompare(b.id)).slice(0,3).map(m=>contribution(g,m,1,'已评估的鱼话题线索；提及不等于喜欢'))}))}
  const preliminary=scoreDecision(state,input,now)
  input.options=[...preliminary.rows].sort((a,b)=>b.score-a.score||a.label.localeCompare(b.label)).slice(0,20).map(r=>input.options.find(o=>o.label===r.label))
  const competition=scoreDecision(state,input,now)
  const ranked=[...competition.rows].sort((a,b)=>b.score-a.score||a.label.localeCompare(b.label))
  const keywords=[],member_competitions=[]
  for(const row of ranked) {
    const g=groups.find(g=>g.collection.id===row.label)
    const byTerm=new Map()
    for(const m of [...g.members].sort((a,b)=>(a.interpretation==='explicit'?0:1)-(b.interpretation==='explicit'?0:1)||a.id.localeCompare(b.id))) {
      const term=termOf(m,g.collection)
      if(term&&!byTerm.has(normalized(term)))byTerm.set(normalized(term),m)
    }
    const memberInput={question:`兴趣集合「${g.collection.name}」用哪个话题检索？`,scene,subject:'fish',seed:seed+':member:'+g.collection.id.slice(-12),
      options:[...byTerm.values()].map(m=>({label:m.id,eligible:true,reason:m.content,contributions:[contribution(g,m,1,'集合内话题检索竞争')]}))}
    const members=scoreDecision(state,memberInput,now)
    memberInput.options=[...members.rows].sort((a,b)=>b.score-a.score||a.label.localeCompare(b.label)).slice(0,20).map(r=>memberInput.options.find(o=>o.label===r.label))
    const memberCompetition=scoreDecision(state,memberInput,now)
    member_competitions.push(memberCompetition)
    const m=g.members.find(m=>m.id===memberCompetition.winner),term=termOf(m,g.collection)
    if(!keywords.some(k=>normalized(k)===normalized(term)))keywords.push(term)
    if(keywords.length>=limit)break
  }
  return {keywords,competition,member_competitions}
}
export function videoContributions(video,groups) {
  const title=normalized(video.t),quality=Math.max(0,Number(video._score)||0)
  // Legacy density/preferences/feedback remain a bounded quality signal. Views
  // remain a filter only, never an additive popularity score.
  const relevance=0.8+0.2*quality/(quality+8)
  return groups.flatMap(g=>{
    const hits=g.members.flatMap(m=>{
      if(m.exclusions.some(x=>useful(x)&&containsTerm(title,x)))return []
      const term=[termOf(m,g.collection),g.collection.name,...m.triggers].filter(x=>x&&useful(x)).find(x=>containsTerm(title,x))
      return term?[{m,term}]:[]
    }).sort((a,b)=>(a.m.interpretation==='explicit'?0:1)-(b.m.interpretation==='explicit'?0:1)||a.m.id.localeCompare(b.m.id))
    return hits.length?[contribution(g,hits[0].m,relevance,`标题命中「${hits[0].term}」；来源成员 ${hits[0].m.id}`)]:[]
  }).slice(0,50)
}

function archive(store,d,emit,state,input,now) {
  const result=scoreDecision(state,input,now),object=store.object(result),state_object=store.object(state),id=crypto.randomUUID()
  d.savePreview(id,{object:object.hash,state_object:state_object.hash,committed:null})
  emit('decision.previewed',{id,object,state_object,winner:result.winner,state_version:result.state_version},{trace_id:input.trace_id??null,source:'feed'})
  return {id,result,object,state_object}
}
function commit(store,d,emit,state,preview,now) {
  const before=hash(state),decision=commitScoredDecision(state,preview.result,{
    preview_id:preview.id,reason:'feed 实际选入阅读清单；不是观看完成或正面反馈',
  },now)
  d.savePreview(preview.id,{object:preview.object.hash,state_object:preview.state_object.hash,committed:decision.id})
  const links={trace_id:decision.trace_id,decision_id:decision.id,source:'feed'}
  emit('decision.committed',decision,links)
  const object=store.object(state),version={id:crypto.randomUUID(),role:'concept_state',status:'present',hash:object.hash,redacted:object.redacted,actor:'feed',at:new Date(now).toISOString()}
  d.addVersion(version);emit('snapshot.captured',version,links)
  emit('state.updated',{before,after:hash(state),object,algorithm:state.parameters.algorithm},links)
  return decision
}

export class FeedConcepts {
  constructor({config,store,runId=crypto.randomUUID(),seed=runId,request={}}) {
    if(typeof runId!=='string'||!runId.length||runId.length>120||typeof seed!=='string'||!seed.length||seed.length>160)throw Error('feed run-id/seed length invalid')
    this.enabled=config.conceptSystem?.observe===true
    this.mode=config.conceptSystem?.mode??'shadow'
    this.store=this.enabled?(store??new ObservationStore()):null
    this.runId=runId;this.seed=seed;this.trace='feed-'+hash(runId).slice(0,32)
    this.request=redact(request)
  }
  resume({n,per}) {
    if(!this.enabled)return null
    return this.store.journal.use(db=>{
      const receipt=key=>{const row=db.prepare('SELECT result FROM receipts WHERE key=?').get(key);return row?JSON.parse(row.result).value:null}
      const selected=receipt('feed-select:'+this.runId)
      if(!selected)return null
      if(selected.n!==n||selected.per!==per||selected.seed!==this.seed||selected.mode!==this.mode||hash(selected.request)!==hash(this.request))throw Error('Completed feed run has different parameters; use a new run-id')
      return {...selected,search:receipt('feed-plan:'+this.runId)}
    })
  }
  async plan(legacyKeywords) {
    if(!this.enabled)return {keywords:legacyKeywords,proposed:[],mode:'disabled'}
    legacyKeywords=redact(legacyKeywords)
    return this.store.transaction({key:'feed-plan:'+this.runId,input:{seed:this.seed,legacyKeywords,mode:this.mode,request:this.request}},(d,emit)=>{
      const state=d.state.concepts,now=this.store.now(),plan=interestPlan(state,this.seed+':interests',now)
      let preview=null
      if(plan.competition)preview=archive(this.store,d,emit,state,{...plan.competition.input,trace_id:this.trace},now).id
      const member_preview_ids=plan.member_competitions.map(c=>archive(this.store,d,emit,state,{...c.input,trace_id:this.trace},now).id)
      const active=this.mode==='active'&&plan.keywords.length>0
      // Reserve two of at most six search slots for explicit/fallback preferences.
      const keywords=active?[...new Set([...plan.keywords,...legacyKeywords])].slice(0,6):legacyKeywords
      const result={keywords,proposed:plan.keywords,mode:this.mode,preview_id:preview,member_preview_ids,run_id:this.runId,seed:this.seed}
      emit('feed.search_planned',result,{trace_id:this.trace})
      return result
    })
  }
  async select({candidates,legacy,n,per}) {
    if(!Number.isInteger(n)||n<1||n>20||!Number.isInteger(per)||per<1||per>20)throw Error('feed n/per must be integers between 1 and 20')
    if(!this.enabled)return {selected:legacy.slice(0,n),mode:'disabled',decisions:[]}
    candidates=redact(candidates);legacy=redact(legacy)
    if(!Array.isArray(candidates)||!Array.isArray(legacy)||candidates.length>400||legacy.some(v=>!candidates.some(c=>c.bv===v.bv)))throw Error('Invalid feed candidate slate')
    if(candidates.some(v=>!/^BV[0-9A-Za-z]{10}$/.test(v.bv)||typeof v.t!=='string'))throw Error('Invalid feed video identity/title')
    // One transaction covers the complete slate and fatigue updates. Repeating an
    // identical run-id returns its durable receipt, even after a process crash.
    return this.store.transaction({key:'feed-select:'+this.runId,input:{candidates,legacy,n,per,seed:this.seed,mode:this.mode,request:this.request}},(d,emit)=>{
      const state=d.state.concepts,groups=feedGroups(state),now=this.store.now()
      const pool_object=this.store.object({candidates,legacy,n,per,policy:'feed-v1'})
      emit('feed.candidates',{object:pool_object,policy:'feed-v1',state_version:state?hash(state):null},{trace_id:this.trace})
      const remaining=[...new Map(candidates.map(v=>[v.bv,v])).values()]
      const selected=[],decisions=[],used=new Map()
      while(state&&groups.length&&selected.length<n) {
        const options=remaining.map(v=>({label:v.bv,eligible:true,reason:String(v.t).slice(0,500)||v.bv,contributions:videoContributions(v,groups)}))
          .filter(o=>o.contributions.length&&o.contributions.every(c=>(used.get(c.collection_id)??0)<per))
        if(!options.length)break
        const input={question:`feed 阅读清单第 ${selected.length+1} 条选什么？`,scene,subject:'fish',trace_id:this.trace,
          seed:`${this.seed}:video:${selected.length}`,...(decisions.length&&this.mode==='active'?{parent_decision_id:decisions.at(-1).id}:{}),options}
        // Rebuild after every fatigue update. Include bounded near-tie noise
        // before cutting to 20 so equal-score late arrivals are not starved.
        const preliminary=scoreDecision(state,input,now)
        input.options=[...preliminary.rows].sort((a,b)=>b.score-a.score||a.label.localeCompare(b.label)).slice(0,20).map(row=>options.find(o=>o.label===row.label))
        emit('feed.slot_candidates',{slot:selected.length+1,eligible:options.length,shortlist:input.options.map(o=>o.label),per_collection_used:Object.fromEntries(used)},{trace_id:this.trace})
        const preview=archive(this.store,d,emit,state,input,now)
        const winner=remaining.find(v=>v.bv===preview.result.winner),row=preview.result.rows.find(r=>r.label===winner.bv)
        selected.push(winner)
        for(const c of options.find(o=>o.label===winner.bv).contributions)used.set(c.collection_id,(used.get(c.collection_id)??0)+1)
        remaining.splice(remaining.indexOf(winner),1)
        if(this.mode==='active')decisions.push(commit(this.store,d,emit,state,preview,now))
        else decisions.push({preview_id:preview.id,selected:winner.bv,shadow:true,contributions:row.contributions})
      }
      const fallback=legacy.filter(v=>!selected.some(s=>s.bv===v.bv)&&!videoContributions(v,groups).length)
      const proposed=groups.length?[...selected,...fallback].slice(0,n):legacy.slice(0,n)
      const actual=this.mode==='active'?proposed:legacy.slice(0,n)
      const result={selected:actual,proposed,mode:this.mode,run_id:this.runId,seed:this.seed,trace_id:this.trace,decisions,n,per,request:this.request,candidate_count:candidates.length,pool_object,policy:'feed-v1',
        fallback:!groups.length?'no_eligible_fish_topics':!selected.length?'no_title_matches':null}
      emit('feed.selected',{...result,candidate_count:candidates.length,selection_scope:'reading_slate_not_viewed'}, {trace_id:this.trace})
      return result
    })
  }
}

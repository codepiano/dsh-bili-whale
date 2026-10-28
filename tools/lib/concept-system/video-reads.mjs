import crypto from 'node:crypto'
import { ObservationStore,hash,redact } from './store.mjs'
import { enqueueLearningSource } from './learning.mjs'
import { settleVideoRead } from './video-state.mjs'

const MAX_TEXT=192000,CHUNK=8000
export function normalizeSubtitles(rows) {
  return (Array.isArray(rows)?rows:[]).slice(0,50000).filter(l=>l&&Number.isFinite(l.from)&&l.from>=0&&typeof l.content==='string'&&l.content.trim())
    .map(l=>({from:l.from,to:Number.isFinite(l.to)&&l.to>=l.from?l.to:l.from,content:l.content.slice(0,4000)}))
}
export function videoMaterial({bvid,cid,title='',description='',duration=0,subtitles=[],track=null,components={},artifacts={}}) {
  if(!/^BV[0-9A-Za-z]{10}$/.test(bvid)||!/^\d+$/.test(String(cid))||Number(cid)<=0||!Number.isFinite(duration)||duration<0)throw Error('Invalid video material identity/duration')
  const normalizedLoss=(Array.isArray(subtitles)&&subtitles.length>50000)||(Array.isArray(subtitles)&&subtitles.some(l=>typeof l?.content==='string'&&l.content.length>4000))||components.subtitle_input?.truncated===true
  const rows=normalizeSubtitles(subtitles)
  const text=rows.length?rows.map(l=>`[${l.from}-${l.to}] ${l.content}`).join('\n'):String(description).trim()
  const kind=rows.length?'subtitles':text?'description':'none'
  const excerpt=redact(text).slice(0,MAX_TEXT),parts=[]
  for(let start=0;start<excerpt.length&&parts.length<24;) {
    let end=Math.min(start+CHUNK,excerpt.length)
    if(end<excerpt.length&&/[\uD800-\uDBFF]/.test(excerpt[end-1]))end--
    const part=excerpt.slice(start,end);if(part.trim())parts.push(part);start=end
  }
  const content_hash=hash(excerpt)
  const sources=parts.map((part,i)=>({
    id:'video-'+hash([bvid,String(cid),kind,content_hash,i]).slice(0,32),actor:'third_party',type:'video',
    excerpt:part,ref:`bili:${bvid}`,
    video:{bvid,cid:String(cid),section:kind,part:i+1,parts:parts.length,content_hash},
  }))
  return redact({bvid,cid:String(cid),title:String(title).slice(0,1000),description:String(description).slice(0,20000),duration,
    kind,track,components,artifacts,content_hash,text:excerpt,sources,
    coverage:{subtitle_lines:rows.length,from:rows[0]?.from??null,to:rows.at(-1)?.to??null,
      original_chars:text.length,retained_chars:parts.reduce((n,s)=>n+s.length,0),truncated:normalizedLoss||text.length>excerpt.length||parts.join('')!==excerpt,
      scope:kind==='subtitles'?'subtitle_material_not_watch_completion':kind==='description'?'description_only':'no_text'},
  })
}

export class VideoReads {
  constructor(store=new ObservationStore()){this.store=store}
  start(bvid,options={}) {
    if(!/^BV[0-9A-Za-z]{10}$/.test(bvid))throw Error('Invalid video ID')
    return this.store.transaction({state:false},(d,emit)=>{
      let feed=null
      if(options.feed_run_id) {
        const selection=d.receipt('feed-select:'+options.feed_run_id)
        if(!selection||!selection.selected.some(v=>v.bv===bvid))throw Error('Video is not in the specified feed reading slate')
        feed={run_id:options.feed_run_id,trace_id:selection.trace_id,decision_id:selection.mode==='active'?(selection.decisions.find(x=>x.selected===bvid)?.id??null):null}
      }
      const read={id:crypto.randomUUID(),bvid,feed,...(feed?{read_policy:'subtitle-pages-v1'}:{}),kind:'none',status:'started',started_at:new Date(this.store.now()).toISOString(),options:redact(options)}
      d.reads.put(read);emit('video.read_started',{read_id:read.id,bvid,options:read.options},{trace_id:feed?.trace_id??null,decision_id:feed?.decision_id??null});return read
    })
  }
  complete(id,packet) {
    const material=videoMaterial(packet),object=this.store.object(material)
    const sources=material.sources.map(source=>({id:source.id,object:this.store.object(source)}))
    return this.store.transaction({state:false,key:'video-complete:'+id,input:object.hash},(d,emit)=>{
      const read=d.reads.get(id)
      if(!read||read.status!=='started'||read.bvid!==material.bvid)throw Error('Invalid video read completion')
      const next={...read,kind:material.kind,status:'acquired',cid:material.cid,material:object,sources,
        content_hash:material.content_hash,coverage:material.coverage,completed_at:new Date(this.store.now()).toISOString(),parts_assessed:0}
      d.reads.put(next)
      emit('video.material_acquired',{read_id:id,bvid:read.bvid,kind:material.kind,object,coverage:material.coverage},{trace_id:read.feed?.trace_id??null,decision_id:read.feed?.decision_id??null})
      return {id,material_hash:object.hash,kind:material.kind,marker:`BILI_DEBRIEF_RECEIPT:${id}:${object.hash}`}
    })
  }
  fail(id,error) {
    return this.store.transaction({state:false},(d,emit)=>{
      const read=d.reads.get(id)
      if(!read||read.status!=='started')return
      d.reads.put({...read,status:'failed',error:redact(String(error?.message??error))})
      emit('video.read_failed',{read_id:id,bvid:read.bvid,error:redact(String(error?.message??error))},{trace_id:read.feed?.trace_id??null,decision_id:read.feed?.decision_id??null})
    })
  }
  queueSources(d,emit,read,{session_id,trace_id,route}) {
    this.store.getObject(read.material.hash)
    for(const spec of read.sources) {
      const source=this.store.getObject(spec.object.hash).content
      if(source.id!==spec.id||source.actor!=='third_party'||source.type!=='video'||source.video?.bvid!==read.bvid||source.video?.cid!==read.cid)throw Error('Video source integrity mismatch')
      const job=enqueueLearningSource(d,emit,{session_id,source,trace_id,route})
      d.reads.bindJob(read.id,job.id)
    }
  }
  async acceptOutput(text,{session_id,trace_id=null,route=null,learn=true,host_seq=null,tool_call_id=null}) {
    let pagePayload;try{pagePayload=JSON.parse(String(text))}catch{}
    if(pagePayload?.type==='bili.subtitle_page.v1')return this.acceptPage(pagePayload,{session_id,trace_id,route,learn,host_seq,tool_call_id})
    const tokens=[...String(text).matchAll(/BILI_DEBRIEF_RECEIPT:([a-f0-9-]{36}):([a-f0-9]{64})/g)].slice(0,24)
    if(!tokens.length)return []
    return this.store.transaction({},(d,emit)=>{
      const accepted=[]
      for(const [,id,digest] of tokens) {
        const read=d.reads.get(id)
        if(!read||read.material?.hash!==digest||!['acquired','presented','assessed'].includes(read.status))continue
        if(read.session_id&&read.session_id!==session_id) {
          emit('video.receipt_rejected',{read_id:id,reason:'receipt_already_bound_to_another_session'},{session_id,trace_id});continue
        }
        if(read.session_id){accepted.push(id);continue}
        // Validate object integrity before admitting any source. No caller can
        // supply text, arbitrary object paths or model routes in the marker.
        this.store.getObject(read.material.hash)
        const queueNow=learn&&!(read.read_policy&&read.kind==='subtitles')
        if(queueNow)this.queueSources(d,emit,read,{session_id,trace_id,route})
        const next={...read,status:'presented',session_id,trace_id,learning_queued:queueNow,requires_delivery:!!read.read_policy&&read.kind==='subtitles'&&String(route?.provider??'').startsWith('deepseek'),presented_at:new Date(this.store.now()).toISOString()}
        d.reads.put(next)
        emit('video.material_presented',{read_id:id,bvid:read.bvid,kind:read.kind,parts:read.sources.length,material:read.material,scope:'tool_result_receipt_not_watch_completion'},{session_id,trace_id,decision_id:read.feed?.decision_id??null})
        if(!next.read_policy)this.expose(d,emit,next,session_id)
        settleVideoRead(d,emit,next,this.store.now());accepted.push(id)
      }
      return accepted
    })
  }
  expose(d,emit,next,session_id) {
        const decision = next.feed?.decision_id
          ? d.state.concepts?.decisions[next.feed.decision_id]
          : null;
        if (
          decision?.exploration &&
          !decision.exploration.exposure &&
          next.kind === "subtitles"
        ) {
          for (const spec of next.sources) {
            const source = this.store.getObject(spec.object.hash).content;
            if (!d.state.concepts.sources[source.id]) {
              d.state.concepts.sources[source.id] = source;
              emit(
                "source.observed",
                { source },
                {
                  session_id,
                  trace_id: next.feed.trace_id,
                  source: "video_receipt",
                },
              );
            }
          }
          const exposure = {
            read_id: next.id,
            bvid: next.bvid,
            at: this.store.now(),
            source_ids: next.sources.map((s) => s.id),
            scope: next.read_policy ? "subtitle_pages_presented_not_watch_completion" : "subtitle_material_presented_not_watch_completion",
            attribution: "host_tool_result_receipt",
          };
          decision.exploration.exposure = exposure;
          const object = this.store.object(d.state.concepts),
            version = {
              id: crypto.randomUUID(),
              role: "concept_state",
              status: "present",
              hash: object.hash,
              redacted: object.redacted,
              actor: "video_receipt",
              at: new Date(this.store.now()).toISOString(),
            };
          d.addVersion(version);
          emit("snapshot.captured", version, {
            session_id,
            trace_id: next.feed.trace_id,
            decision_id: decision.id,
          });
          emit("exploration.exposed", exposure, {
            session_id,
            trace_id: next.feed.trace_id,
            decision_id: decision.id,
          });
        }
  }
  page({read_id,page}) {
    return this.store.transaction({state:false},d=>{
      const read=d.reads.get(read_id)
      if(!read?.session_id||read.kind!=='subtitles')throw Error('Subtitle page needs a presented subtitle receipt')
      if(read.coverage.truncated)throw Error('Truncated acquisition cannot claim a complete subtitle read')
      const source=read.sources[page-1]
      if(!source)throw Error('Unknown subtitle page')
      const text=this.store.getObject(source.object.hash).content.excerpt
      return {type:'bili.subtitle_page.v1',read_id,page,total_pages:read.sources.length,material_hash:read.material.hash,text,receipt_hash:hash([read_id,page,source.object.hash,text])}
    })
  }
  async acceptPage(payload,{session_id,trace_id=null,route=null,learn=true,host_seq=null,tool_call_id=null}) {
    if(payload?.type!=='bili.subtitle_page.v1')return []
    return this.store.transaction({},(d,emit)=>{
      const read=d.reads.get(payload.read_id),page=payload.page
      if(!read||read.session_id!==session_id||read.kind!=='subtitles'||read.coverage.truncated||!Number.isInteger(page))return []
      if(read.requires_delivery&&!Number.isSafeInteger(host_seq))return []
      const source=read.sources[page-1];if(!source)return []
      const text=this.store.getObject(source.object.hash).content.excerpt
      if(payload.material_hash!==read.material.hash||payload.total_pages!==read.sources.length||payload.text!==text||payload.receipt_hash!==hash([read.id,page,source.object.hash,text]))return []
      const pages=[...new Set([...(read.pages_presented??[]),page])].sort((a,b)=>a-b)
      if(read.pages_presented?.includes(page))return [read.id]
      const complete=pages.length===read.sources.length,next={...read,pages_presented:pages,body_complete:complete,last_page_host_seq:Number.isSafeInteger(host_seq)?Math.max(host_seq,read.last_page_host_seq??0):null,reading_complete:false}
      emit('video.subtitle_page_presented',{read_id:read.id,page,total_pages:read.sources.length,object:source.object,host_seq,tool_call_id},{session_id,trace_id,decision_id:read.feed?.decision_id??null})
      if(complete&&!read.requires_delivery)this.finishReading(d,emit,next,{session_id,trace_id,route,learn})
      if(!complete||read.requires_delivery)d.reads.put(next);return [read.id]
    })
  }
  finishReading(d,emit,read,{session_id,trace_id=null,route=null,learn=true,delivery=null}) {
    const next={...read,reading_complete:true,read_completed_at:new Date(this.store.now()).toISOString(),learning_queued:read.learning_queued||learn,...(delivery?{delivery}: {})}
    if(learn&&!read.learning_queued)this.queueSources(d,emit,read,{session_id,trace_id,route})
    emit('video.subtitle_read_completed',{read_id:read.id,bvid:read.bvid,pages:read.pages_presented.length,source_ids:read.sources.map(s=>s.id),delivery,scope:delivery?'all_subtitle_pages_delivered_to_model':'all_subtitle_pages_in_native_tool_results'},{session_id,trace_id,decision_id:read.feed?.decision_id??null})
    this.expose(d,emit,next,session_id);d.reads.put(next);settleVideoRead(d,emit,next,this.store.now())
  }
  acceptDelivery({session_id,through_seq,host_seq,route=null,learn=true}) {
    if(!Number.isSafeInteger(through_seq)||!Number.isSafeInteger(host_seq))return []
    const ids=this.store.journal.use(db=>db.prepare("SELECT id FROM video_reads WHERE json_extract(payload,'$.session_id')=? AND json_extract(payload,'$.requires_delivery')=1 AND json_extract(payload,'$.body_complete')=1 AND json_extract(payload,'$.reading_complete') IS NOT 1").all(session_id).map(r=>r.id))
    return this.store.transaction({},(d,emit)=>{
      const rows=ids.map(id=>d.reads.get(id)).filter(read=>read?.session_id===session_id&&read.body_complete&&!read.reading_complete)
      const accepted=[]
      for(const read of rows)if(Number.isSafeInteger(read.last_page_host_seq)&&through_seq>=read.last_page_host_seq) {
        this.finishReading(d,emit,read,{session_id,trace_id:read.trace_id??null,route,learn,delivery:{through_seq,host_seq,last_page_host_seq:read.last_page_host_seq}});accepted.push(read.id)
      }
      return accepted
    })
  }
  resume(session_id,route=null) {
    return this.store.transaction({state:false},(d,emit)=>{
      for(const read of d.reads.awaiting(session_id)) {
        if(read.read_policy&&read.kind==='subtitles'&&!read.reading_complete)continue
        this.queueSources(d,emit,read,{session_id,trace_id:read.trace_id??null,route})
        const next={...read,learning_queued:true};d.reads.put(next);settleVideoRead(d,emit,next,this.store.now())
      }
    })
  }
  seen() {
    return this.store.journal.use(db=>db.prepare("SELECT DISTINCT bvid FROM video_reads WHERE kind='subtitles' AND (json_extract(payload,'$.read_policy') IS NULL OR json_extract(payload,'$.reading_complete')=1) AND status IN ('presented','assessed') ORDER BY bvid").all().map(r=>r.bvid))
  }
  get(id) {
    return this.store.transaction({state:false},d=>d.reads.get(id))
  }
}

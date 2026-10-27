import crypto from 'node:crypto'
import { z } from 'zod'
import { ConceptEngine } from './engine.mjs'
import { schemas } from './schemas.mjs'
import { hash, redact } from './store.mjs'

const candidate = schemas.concept_propose.omit({key:true,source:true,trace_id:true}).extend({
  quote:z.string().trim().min(1).max(600),
  content:z.string().trim().min(1).max(600),
  status:z.enum(['accepted','deferred','rejected']),
  reason:z.string().trim().min(1).max(1000),
  collections:z.array(z.string().trim().min(1).max(100)).max(3),
}).strict()
export const evaluationSchema = z.object({candidates:z.array(candidate).max(6)}).strict()
const expressionTags = new Set(['word','phrase','idiom','sentence_pattern'])

// No model-authored IDs, sources, rewards, file writes or tool calls are accepted.
export function validateEvaluation(raw, source) {
  const parsed = evaluationSchema.parse(raw)
  for (const c of parsed.candidates) {
    if (!source.excerpt.includes(c.quote)) throw Error('Evaluation quote is not in source')
    if (c.status === 'accepted' && !c.collections.length) throw Error('Accepted candidate needs a collection')
    if (c.status !== 'accepted' && c.collections.length) throw Error('Only accepted candidates can join collections')
    if (c.subject !== source.actor && !(source.actor === 'user' && c.subject === 'fish' && c.tags.every(t=>expressionTags.has(t))))
      throw Error('Evaluation subject does not match evidence')
    // A mention can become a topic/word collection; it cannot become an asserted belief or motive.
    if ((c.tags.includes('belief') || c.tags.includes('motive')) && c.interpretation !== 'explicit' && c.status === 'accepted')
      throw Error('Beliefs and motives require explicit evidence')
    if (['negated','quoted','uncertain'].includes(c.interpretation) && c.status === 'accepted')
      throw Error('Ambiguous or negative evidence must remain deferred/rejected')
  }
  return parsed
}

export class LearningQueue {
  constructor(store) { this.store=store }
  tx(fn) { return this.store.transaction({state:false},fn) }
  async enqueue({session_id, source, trace_id=null, route=null}) {
    source=redact(schemas.concept_propose.shape.source.parse(source))
    const id='learn-'+hash([session_id,source.id]).slice(0,32)
    return this.tx((d,emit)=>{
      const old=d.jobs.get(id)
      if(old) {
        if(hash(old.source)!==hash(source)) throw Error('Learning source identity reused')
        return old
      }
      const job={id,session_id,source,trace_id,route,status:'pending',attempts:0,available_at:0,lease_until:0}
      d.jobs.put(job); emit('learning.enqueued',{job_id:id,source_id:source.id,actor:source.actor},{session_id,trace_id})
      return job
    })
  }
  async route(session_id,route) {
    if(typeof route?.provider!=='string'||!route.provider||typeof route?.model!=='string'||!route.model) return
    return this.tx(d=>{for(const job of d.jobs.list(session_id)) {
      // A running request keeps its original route; recovery/retry uses the recorded route.
      if(job.status==='pending'||(!job.route&&job.status!=='running')) d.jobs.put({...job,route:{provider:route.provider,model:route.model}})
    }})
  }
  async ready(session_id) {
    return this.tx((d,emit)=>{for(const job of d.jobs.list(session_id)) if(job.status==='pending') {
      d.jobs.put({...job,status:'ready'})
      emit('learning.ready',{job_id:job.id},{session_id,trace_id:job.trace_id})
    }})
  }
  async claim(acceptSession=()=>true) {
    const now=this.store.now()
    return this.tx((d,emit)=>{
      const job=d.jobs.list().find(j=>acceptSession(j.session_id) && j.route && ((j.status==='ready'&&j.available_at<=now)||(j.status==='running'&&j.lease_until<=now)))
      if(!job)return null
      if(job.attempts>=3 && !job.evaluation) {
        d.jobs.put({...job,status:'failed',lease_until:0})
        emit('learning.failed',{job_id:job.id,error:'Retry limit reached'},{session_id:job.session_id,trace_id:job.trace_id})
        return null
      }
      const next={...job,status:'running',attempts:job.attempts+1,lease_until:now+90000,lease_id:crypto.randomUUID()}
      d.jobs.put(next);emit('learning.started',{job_id:job.id,attempt:next.attempts,route:job.route},{session_id:job.session_id,trace_id:job.trace_id})
      return next
    })
  }
  async update(job,fields,event) {
    return this.tx((d,emit)=>{
      const current=d.jobs.get(job.id)
      if(current?.lease_id!==job.lease_id || current.status!=='running' || current.lease_until<=this.store.now()) throw Error('Learning lease lost')
      const next={...current,...redact(fields)};d.jobs.put(next)
      emit(event,{job_id:job.id,...fields},{session_id:job.session_id,trace_id:job.trace_id})
      return next
    })
  }
}

// One owner per host, SQLite lease across hosts, bounded work per wake. A validated
// response is saved before application, so recovery reuses it instead of re-inferencing.
export class LearningWorker {
  constructor({store,evaluate,enabled=()=>true,acceptSession=()=>true,log=()=>{}}) {
    this.queue=new LearningQueue(store);this.store=store;this.engine=new ConceptEngine(store)
    this.evaluate=evaluate;this.enabled=enabled;this.acceptSession=acceptSession;this.log=log;this.stopped=false;this.running=null;this.abort=new AbortController()
  }
  wake() {
    if(this.stopped||!this.enabled())return Promise.resolve()
    if(!this.running)this.running=this.drain().catch(e=>this.log('Learning worker: '+redact(e.message))).finally(()=>{this.running=null})
    return this.running
  }
  async drain() {
    for(let n=0;n<4&&!this.stopped&&this.enabled();n++) {
      let job=await this.queue.claim(this.acceptSession);if(!job)break
      try {
        if(!job.evaluation) {
          const request=this.store.object({source:job.source,route:job.route,policy:'learning-v1'})
          await this.store.event('learning.request',{job_id:job.id,request},{session_id:job.session_id,trace_id:job.trace_id})
          const response=await this.evaluate(job,this.abort.signal)
          const evidence=this.store.object(response)
          await this.store.event('learning.response',{job_id:job.id,object:evidence},{session_id:job.session_id,trace_id:job.trace_id})
          const evaluation=validateEvaluation(typeof response.text==='string'?JSON.parse(response.text):response,job.source)
          job=await this.queue.update(job,{evaluation},'learning.validated')
        }
        for(const [i,c] of job.evaluation.candidates.entries()) {
          if(this.stopped||!this.enabled())throw Error('Learning paused')
          // Renew ownership before each idempotent application.
          job=await this.queue.update(job,{lease_until:this.store.now()+90000},'learning.applying')
          const {quote,status,reason,collections,...proposal}=c
          const key=`${job.id}:${i}`,links=job.trace_id?{trace_id:job.trace_id}:{}
          const m=await this.engine.call('concept_propose',{...proposal,...links,key,source:job.source})
          await this.engine.call('concept_review',{...links,key,candidate_id:m.id,status,reason,collections:collections.map(name=>({name}))})
        }
        await this.queue.update(job,{status:'done',lease_until:0},'learning.completed')
      } catch(e) {
        const error=redact(e.message)
        try { await this.queue.update(job,{status:job.attempts>=3?'failed':'ready',lease_until:0,available_at:this.store.now()+30000*2**(job.attempts-1),error},job.attempts>=3?'learning.failed':'learning.retry') }
        catch(lost) { this.log('Learning completion unavailable: '+redact(lost.message)) }
      }
    }
  }
  start() {this.timer=setInterval(()=>this.wake(),30000);this.timer.unref?.();return this.wake()}
  async stop() {this.stopped=true;clearInterval(this.timer);this.abort.abort();await this.running}
}

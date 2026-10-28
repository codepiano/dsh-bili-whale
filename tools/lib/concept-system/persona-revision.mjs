import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { z } from 'zod'
import { HOME } from '../paths.mjs'
import { ObservationStore, hash, atomicWrite, redact } from './store.mjs'

export const personaFile=()=>path.join(HOME,'.bili-ai','persona.md')
const eventFor=(store,type,id)=>store.journal.use(db=>{const row=db.prepare("SELECT payload FROM events WHERE type=? AND json_extract(payload,'$.data.attempt_id')=? ORDER BY seq DESC LIMIT 1").get(type,id);return row?JSON.parse(row.payload):null})
const failures=store=>store.journal.use(db=>db.prepare("SELECT payload FROM events WHERE type='persona.reflection_failed' AND json_extract(payload,'$.data.retry')=0 ORDER BY seq DESC LIMIT 100").all().map(r=>JSON.parse(r.payload)))
const init=()=>({schema:1,history:[],seen:[],pending:null,attempt:null})
const evidence=z.object({source_id:z.string().min(1).max(200),quote:z.string().trim().min(1).max(600)}).strict()
export const revisionSchema=z.object({edits:z.array(z.object({before:z.string().max(2000),after:z.string().max(2000),reason:z.string().trim().min(1).max(1000),trigger:z.enum(['feedback','reflection']),evidence:z.array(evidence).min(1).max(8)}).strict()).max(3),reason:z.string().trim().min(1).max(1000)}).strict()
function safeFile(file) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})
  if(fs.lstatSync(path.dirname(file)).isSymbolicLink())throw Error('Symlinked persona directory rejected')
  try {if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw Error('Persona must be a regular file')}catch(e){if(e.code!=='ENOENT')throw e}
}
export function readPersona(file=personaFile()) {
  safeFile(file)
  let text='';try{text=fs.readFileSync(file,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
  if(text.length>20000)throw Error('Persona exceeds 20000 characters')
  if(redact(text)!==text)throw Error('Persona contains sensitive data; automatic revision refused')
  return {text,hash:hash(text)}
}
export async function withPersonaLock(file,fn) {
  safeFile(file);const lock=file+'.revision.lock';let fd
  try {fd=fs.openSync(lock,'wx',0o600)}catch(e){if(e.code!=='EEXIST')throw e
    let owner;try{owner=JSON.parse(fs.readFileSync(lock,'utf8'))}catch{throw Error('Persona lock needs inspection')}
    try{process.kill(owner.pid,0);throw Error('Persona writer busy')}catch(err){if(err.code!=='ESRCH')throw err}
    fs.unlinkSync(lock);fd=fs.openSync(lock,'wx',0o600)
  }
  try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));return await fn()}finally{fs.closeSync(fd);fs.unlinkSync(lock)}
}
export function validateRevision(raw,base,sources) {
  const result=revisionSchema.parse(raw);let text=base
  for(const [index,edit] of result.edits.entries()) {
    if(edit.before===edit.after)throw Error('Empty persona edit')
    const cited=edit.evidence.map(e=>{
      const source=sources.find(s=>s.id===e.source_id)
      if(!source||!source.excerpt.includes(e.quote))throw Error('Persona quote is not in offered source')
      return source
    })
    if(edit.trigger==='feedback'&&!cited.some(s=>s.actor==='user'))throw Error('Feedback revision needs direct user evidence')
    if(edit.trigger==='reflection'&&new Set(cited.filter(s=>s.actor==='fish').map(s=>hash(s.excerpt))).size<2)throw Error('edits['+index+']: Reflection needs two independent fish experiences from DIFFERENT source_ids; offered fish citations were '+cited.filter(s=>s.actor==='fish').map(s=>s.id).join(',')+'; omit this edit if evidence is insufficient')
    if(edit.before) {
      if(text.split(edit.before).length!==2)throw Error('Persona patch must match exactly once')
      text=text.replace(edit.before,edit.after)
    } else {
      if(!edit.after.trim()||text.includes(edit.after.trim()))throw Error('Duplicate/empty persona addition')
      text=text.trimEnd()+'\n\n'+edit.after.trim()+'\n'
    }
  }
  if(text.length>20000||!text.trim()||redact(text)!==text)throw Error('Invalid resulting persona')
  return {...result,text}
}
export class PersonaRevisions {
  constructor({store=new ObservationStore(),file=personaFile()}={}){this.store=store;this.file=file}
  status(limit=20){const state=this.store.state().persona_revision??init();const current=readPersona(this.file);return {current_hash:current.hash,current_text:current.text,pending:state.pending?.id??null,failures:failures(this.store).map(e=>({attempt_id:e.data.attempt_id,error:e.data.error,at:e.at})),history:state.history.slice(-limit).reverse()}}
  async recoverLocked() {
    const p=this.store.state().persona_revision?.pending;if(!p)return
    const current=readPersona(this.file)
    if(current.hash!==p.before_hash&&current.hash!==p.after_hash) {
      await this.store.transaction({},(d,emit)=>{d.state.persona_revision.pending=null;emit('persona.revision_conflict',{revision_id:p.id,current_hash:current.hash})});throw Error('Persona recovery conflict; external edit preserved')
    }
    if(current.hash===p.before_hash)atomicWrite(this.file,this.store.getObject(p.after_object).content)
    await this.store.transaction({},(d,emit)=>{const s=d.state.persona_revision;if(s.pending?.id!==p.id)throw Error('Persona pending revision changed');if(!s.history.some(r=>r.id===p.id))s.history.push(p);s.pending=null;d.addVersion({id:p.id,role:'persona',status:'present',hash:p.after_object,actor:p.kind,at:p.at});emit('persona.revision_applied',p,{session_id:p.session_id??null})})
  }
  async apply({expected_hash,text,reason,evidence=[],edits=[],kind='automatic',session_id=null,rollback_of=null,idempotency_key=null,canApply=()=>true}) {
    return withPersonaLock(this.file,async()=>{
      await this.recoverLocked();const old=idempotency_key?this.store.state().persona_revision?.history.find(r=>r.idempotency_key===idempotency_key):null;if(old)return old;if(!canApply())throw Object.assign(Error('Persona foreground became active'),{code:'PERSONA_BUSY'});const current=readPersona(this.file)
      if(current.hash!==expected_hash)throw Error('Persona changed since reflection; external edit preserved')
      if(text===current.text)return {unchanged:true,current_hash:current.hash}
      if(text.length>20000||!text.trim()||redact(text)!==text)throw Error('Invalid resulting persona')
      const before=this.store.object(current.text),after=this.store.object(text)
      const revision={id:crypto.randomUUID(),kind,at:new Date(this.store.now()).toISOString(),before_hash:current.hash,after_hash:hash(text),before_object:before.hash,after_object:after.hash,reason,evidence,edits,session_id,rollback_of,idempotency_key}
      await this.store.transaction({},(d,emit)=>{const s=(d.state.persona_revision??=init());if(s.pending)throw Error('Pending persona revision');s.pending=revision;emit('persona.revision_prepared',revision,{session_id})})
      await this.recoverLocked();return revision
    })
  }
  async recover(){return withPersonaLock(this.file,()=>this.recoverLocked())}
  async retry({attempt_id,expected_hash,reason}) {
    const failed=eventFor(this.store,'persona.reflection_failed',attempt_id)
    if(!failed||failed.data.retry!==false)throw Error('Unknown exhausted persona reflection')
    const requested=eventFor(this.store,'persona.reflection_requested',attempt_id)
    const queued=eventFor(this.store,'persona.reflection_queued',attempt_id)
    if(!requested||!queued)throw Error('Missing original persona reflection provenance')
    const original=this.store.getObject(requested.data.request.hash).content
    return withPersonaLock(this.file,async()=>{
      await this.recoverLocked();const base=readPersona(this.file)
      if(base.hash!==expected_hash)throw Error('Persona changed since retry request')
      return this.store.transaction({},(d,emit)=>{
        const s=(d.state.persona_revision??=init())
        if(s.attempt&&!['failed','complete'].includes(s.attempt.status))throw Error('Persona reflection already pending')
        for(const source of original.sources){const jobs=(queued.data.evidence_job_ids??queued.data.job_ids).map(id=>d.jobs.get(id));if(!jobs.some(j=>j?.status==='done'&&j.source.id===source.id&&j.source.actor===source.actor&&j.source.excerpt.startsWith(source.excerpt)))throw Error('Original completed source is no longer available')}
        const row={id:crypto.randomUUID(),retry_of:attempt_id,error:failed.data.error,status:'ready',attempts:0,available_at:0,owner:null,lease_until:0,job_ids:queued.data.job_ids,evidence_job_ids:queued.data.evidence_job_ids??queued.data.job_ids,source_ids:original.sources.map(x=>x.id),request:{...original,base}}
        s.attempt=row;emit('persona.reflection_retried',{attempt_id:row.id,retry_of:attempt_id,reason});emit('persona.reflection_queued',{attempt_id:row.id,job_ids:row.job_ids,evidence_job_ids:row.evidence_job_ids,source_ids:row.source_ids,retry_of:attempt_id});return {attempt_id:row.id,retry_of:attempt_id,queued:true}
      })
    })
  }
  async rollback({revision_id,expected_hash,reason}) {
    const revision=this.store.state().persona_revision?.history.find(r=>r.id===revision_id)
    if(!revision)throw Error('Unknown persona revision')
    return this.apply({expected_hash,text:this.store.getObject(revision.before_object).content,reason,kind:'rollback',rollback_of:revision_id,evidence:revision.evidence})
  }
}

// Durable automatic reflection cursor. Historical real jobs are eligible at
// startup; completed sources are never re-enqueued or relabeled as new events.
export class PersonaRevisionWorker {
  constructor({store,file,evaluate,enabled=()=>true,idle=()=>true,acceptSession=()=>true,now=Date.now,log=()=>{}}) {
    this.store=store;this.manager=new PersonaRevisions({store,file});this.evaluate=evaluate;this.enabled=enabled;this.idle=idle;this.acceptSession=acceptSession;this.now=now;this.log=log;this.abort=new AbortController();this.running=null;this.stopped=false;this.owner=crypto.randomUUID()
  }
  wake(){if(this.stopped||!this.enabled()||!this.idle())return Promise.resolve();if(!this.running)this.running=this.run().catch(e=>this.log('Persona reflection: '+redact(e.message))).finally(()=>{this.running=null});return this.running}
  async run(){
    await this.manager.recover()
    let attempt=await this.store.transaction({},(d,emit)=>{
      const s=(d.state.persona_revision??=init())
      if(s.attempt?.status==='failed'||s.attempt?.status==='complete')s.attempt=null
      if(s.attempt){if(s.attempt.available_at>this.now()||(s.attempt.owner!==this.owner&&s.attempt.lease_until>this.now()))return null;s.attempt.owner=this.owner;s.attempt.lease_until=this.now()+90000;return s.attempt}
      const completed=d.jobs.completed().filter(j=>j.route&&this.acceptSession(j.session_id)),unseen=completed.filter(j=>!s.seen.includes(j.id))
      if(!unseen.length)return null
      const priorSeen=new Set(s.seen),jobs=unseen.slice(-20);if(unseen.length>20){const older=unseen.slice(0,-20).map(j=>j.id);s.seen=[...new Set([...s.seen,...older])];emit('persona.reflection_backlog_bounded',{older_job_ids:older,reason:'Startup reflection uses the most recent 20 completed sources; originals preserved'})}const base=readPersona(this.manager.file)
      const support=completed.filter(j=>priorSeen.has(j.id)&&j.source.actor==='fish').slice(-2)
      const sources=[...jobs,...support].map(j=>j.source).filter(s=>!(s.actor!=='third_party'&&/^(?:验收完成|已完成本轮只读验收|这是.*(?:验收|接入验证)|请执行.*验收|新版本已发布)/.test(s.excerpt.trim())))
      // Reflection requires lived fish statements or direct owner feedback, never
      // adopting a video author's words as the agent's personal position.
      const fish=new Set(sources.filter(s=>s.actor==='fish').map(s=>hash(s.excerpt)))
      if(!sources.some(s=>s.actor==='user')&&fish.size<2){return null}
      const offered=sources.map(s=>({...s,excerpt:s.excerpt.slice(0,4000)}))
      const row={id:crypto.randomUUID(),status:'ready',attempts:0,available_at:0,owner:this.owner,lease_until:this.now()+90000,job_ids:jobs.map(j=>j.id),evidence_job_ids:[...jobs,...support].map(j=>j.id),source_ids:offered.map(s=>s.id),request:{base,sources:offered,route:jobs.at(-1).route,session_id:jobs.at(-1).session_id}}
      s.attempt=row;emit('persona.reflection_queued',{attempt_id:row.id,job_ids:row.job_ids,evidence_job_ids:row.evidence_job_ids,source_ids:row.source_ids});return row
    })
    if(!attempt||!this.enabled()||!this.idle())return
    if(!attempt.evaluation){
      attempt=await this.store.transaction({},(d,emit)=>{const a=d.state.persona_revision.attempt;if(a.owner!==this.owner)throw Error('Persona reflection lease lost');a.attempts++;const request=this.store.object({...a.request,previous_error:a.error??null});emit('persona.reflection_requested',{attempt_id:a.id,request});return a})
      try {
        const response=await this.evaluate({...attempt.request,previous_error:attempt.error??null},this.abort.signal)
        await this.store.event('persona.reflection_response',{attempt_id:attempt.id,object:this.store.object(response)})
        const value=validateRevision(typeof response.text==='string'?JSON.parse(response.text):response,attempt.request.base.text,attempt.request.sources)
        attempt=await this.store.transaction({},(d,emit)=>{const a=d.state.persona_revision.attempt;if(a.owner!==this.owner)throw Error('Persona reflection lease lost');a.evaluation=value;emit('persona.reflection_validated',{attempt_id:a.id,edits:value.edits.length});return a})
      }catch(e){await this.store.transaction({},(d,emit)=>{const s=d.state.persona_revision,a=s.attempt;a.error=redact(e.message);a.available_at=this.now()+60000;if(a.attempts>=3){a.status='failed';s.seen=[...new Set([...s.seen,...a.job_ids])]}emit('persona.reflection_failed',{attempt_id:a.id,retry:a.attempts<3,error:a.error})});return}
    }
    if(!this.enabled()||!this.idle()||this.stopped){await this.store.transaction({},d=>{const a=d.state.persona_revision.attempt;if(a?.owner===this.owner)a.lease_until=0});return}
    let revision=null
    try {
      if(attempt.evaluation.edits.length)revision=await this.manager.apply({expected_hash:attempt.request.base.hash,text:attempt.evaluation.text,reason:attempt.evaluation.reason,edits:attempt.evaluation.edits,evidence:attempt.evaluation.edits.flatMap(e=>e.evidence),session_id:attempt.request.session_id,idempotency_key:attempt.id,canApply:()=>this.enabled()&&this.idle()&&!this.stopped})
      await this.store.transaction({},(d,emit)=>{const s=d.state.persona_revision;s.seen=[...new Set([...s.seen,...attempt.job_ids])];s.attempt.status='complete';emit('persona.reflection_completed',{attempt_id:attempt.id,revision_id:revision?.id??null,reason:attempt.evaluation.reason},{session_id:attempt.request.session_id})})
    }catch(e){if(e.code==='PERSONA_BUSY'){await this.store.transaction({},d=>{d.state.persona_revision.attempt.lease_until=0});return}await this.store.transaction({},(d,emit)=>{const s=d.state.persona_revision;s.seen=[...new Set([...s.seen,...attempt.job_ids])];s.attempt.status='failed';emit('persona.reflection_conflict',{attempt_id:attempt.id,error:redact(e.message)})})}
  }
  start(){this.timer=setInterval(()=>void this.wake(),30000);this.timer.unref?.();void this.wake()}
  async stop(){this.stopped=true;clearInterval(this.timer);this.abort.abort();await this.running}
}

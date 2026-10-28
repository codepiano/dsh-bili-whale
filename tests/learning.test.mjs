import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ObservationStore } from '../tools/lib/concept-system/store.mjs'
import { Observer, attachSessionEvents } from '../tools/lib/concept-system/observation.mjs'
import { LearningQueue, LearningWorker, validateEvaluation } from '../tools/lib/concept-system/learning.mjs'
import { createLearningHost, evaluateWithHost } from '../lib/learning-host.js'
import { createSessionDelivery } from '../lib/session-delivery.js'

function box(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-learning-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root
}
const route={provider:'test',model:'fixture'}
const source={id:'user-1',actor:'user',type:'conversation',excerpt:'最近想读康德，也常说慢慢来。',ref:'test:1'}
const result=()=>({candidates:[{subject:'user',content:'康德',tags:['topic'],scene:'general',triggers:[],exclusions:[],interpretation:'mention',quote:'康德',status:'accepted',reason:'提及阅读方向，不推断认同',collections:['哲学阅读']}]})
const event=(seq,type,data)=>({seq,type,data,time:Date.now()})
function host() {
  const hooks=new Map()
  return {hooks,on(type,fn){const list=hooks.get(type)??[];list.push(fn);hooks.set(type,list);return ()=>hooks.set(type,(hooks.get(type)??[]).filter(x=>x!==fn))}}
}
async function assemble(ctx,id='fish',signal) {
  const base={sections:[],contexts:[],tools:[],variables:route}
  return ctx.hooks.get('system-prompt/assemble')[0](base,{agent:{session:{id}},signal},()=>base)
}
function job(store,id) {return store.journal.use(db=>JSON.parse(db.prepare('SELECT payload FROM learning_jobs WHERE id=?').get(id).payload))}

test('sources persist before turn end, deduplicate, and only become eligible at end',async t=>{
  const store=new ObservationStore(box(t)),q=new LearningQueue(store)
  const a=await q.enqueue({session_id:'fish',source,route})
  assert.equal((await q.enqueue({session_id:'fish',source,route})).id,a.id)
  await assert.rejects(q.enqueue({session_id:'fish',source:{...source,excerpt:'different'},route}),/identity reused/)
  assert.equal(await q.claim(),null)
  await q.ready('other');assert.equal(await q.claim(),null)
  await q.ready('fish');assert.equal((await q.claim()).id,a.id)
  assert.equal(await new LearningQueue(new ObservationStore(store.directory)).claim(),null)
  assert.equal(store.events({type:'learning.enqueued'}).length,1)
})

test('expired lease recovers across workers; a stale owner cannot complete it',async t=>{
  let now=0
  const store=new ObservationStore(box(t),{now:()=>now}),q=new LearningQueue(store)
  await q.enqueue({session_id:'fish',source,route});await q.ready('fish')
  const a=await q.claim();now=90001
  const b=await new LearningQueue(new ObservationStore(store.directory,{now:()=>now})).claim()
  assert.notEqual(a.lease_id,b.lease_id)
  await assert.rejects(q.update(a,{status:'done'},'test'),/lease lost/)
  assert.equal(b.attempts,2)
})

test('worker automatically validates, proposes, reviews and records versions without tool prompting',async t=>{
  const store=new ObservationStore(box(t)),w=new LearningWorker({store,evaluate:async()=>({text:JSON.stringify(result()),reasoning:'fixture reasoning'})})
  const a=await w.queue.enqueue({session_id:'fish',source,route});await w.queue.ready('fish');await w.wake()
  assert.equal(job(store,a.id).status,'done')
  const state=store.state().concepts
  assert.equal(Object.values(state.members)[0].status,'accepted')
  assert.equal(Object.values(state.collections)[0].subject,'user')
  assert.ok(store.versions('concept_state').length>=2)
  assert.equal(store.events({type:'learning.response'}).length,1)
  await w.wake();assert.equal(store.events({type:'candidate.proposed'}).length,1)
  await w.stop()
})

test('invalid output retries with backoff then fails without learning; missing routes do not spend attempts',async t=>{
  let now=0,calls=0
  const store=new ObservationStore(box(t),{now:()=>now}),w=new LearningWorker({store,evaluate:async()=>{calls++;return {text:'not json'}}})
  const a=await w.queue.enqueue({session_id:'fish',source});await w.queue.ready('fish');await w.wake();assert.equal(calls,0)
  await w.queue.route('fish',route);await w.wake();assert.equal(calls,1)
  await w.wake();assert.equal(calls,1)
  now=30000;await w.wake();assert.equal(calls,2)
  now=90000;await w.wake();assert.equal(calls,3)
  assert.equal(job(store,a.id).status,'failed')
  now=1000000;await w.wake();assert.equal(calls,3)
  assert.equal(store.state().concepts,undefined);await w.stop()
})

test('a saved validated evaluation survives restart and partially applied learning is idempotent',async t=>{
  let now=0
  const store=new ObservationStore(box(t),{now:()=>now}),q=new LearningQueue(store)
  const a=await q.enqueue({session_id:'fish',source,route});await q.ready('fish')
  let leased=await q.claim();leased=await q.update(leased,{evaluation:validateEvaluation(result(),source)},'learning.validated')
  const w=new LearningWorker({store,evaluate:()=>assert.fail('must reuse validated result')})
  const original=w.engine.call.bind(w.engine);let fail=true
  w.engine.call=async(name,input)=>{if(name==='concept_review'&&fail){fail=false;throw Error('simulated interruption')}return original(name,input)}
  now=90001;await w.wake();assert.equal(Object.keys(store.state().concepts.members).length,1)
  now+=60000;await w.wake()
  assert.equal(job(store,a.id).status,'done');assert.equal(store.events({type:'candidate.proposed'}).length,1)
  await w.stop()
})

test('evidence rules reject invented quotes, source swaps, ungrounded beliefs and negative adoption',()=>{
  for(const patch of [{quote:'不存在的词'},{subject:'fish'},{tags:['belief']},{interpretation:'negated'},{extra:'hidden'},{collections:[]}]) {
    const r=result();Object.assign(r.candidates[0],patch);assert.throws(()=>validateEvaluation(r,source))
  }
  const imitation=result();Object.assign(imitation.candidates[0],{subject:'fish',content:'慢慢来',quote:'慢慢来',tags:['phrase'],collections:['日常表达']})
  assert.equal(validateEvaluation(imitation,source).candidates[0].subject,'fish')
})

test('host event -> durable queue -> turn end -> automatic evaluation -> every-step context, scoped by session',async t=>{
  const store=new ObservationStore(box(t)),ctx=host(),observer=new Observer({store,paths:{}})
  let calls=0,cfg={conceptSystem:{observe:true,learning:true,mode:'active',renderBudget:400}}
  const learning=createLearningHost({ctx,observer,config:()=>cfg,sessionIds:['fish'],start:false,evaluate:async()=>{calls++;return result()}})
  const observation=attachSessionEvents(ctx,observer,'fish',{onEvent:learning.onEvent})
  const send=(s,e)=>ctx.hooks.get('session/event')[0]({id:s},e)
  send('other',event(1,'user/message',{source:{kind:'user'},content:[{type:'text',text:source.excerpt}]}))
  send('fish',event(1,'user/message',{source:{kind:'user'},content:[{type:'text',text:source.excerpt}]}))
  send('fish',event(2,'request/header',{header:{config:route}}))
  await observation.stop();assert.equal(calls,0)
  await learning.onEvent({id:'fish'},event(3,'turn/end',{}));await learning.worker.wake();assert.equal(calls,1)
  const step=ctx.hooks.get('agent/pre-step')[0],agent={session:{id:'fish'}},base={id:'m1',role:'user',source:{kind:'user'},content:[{type:'text',text:'聊聊吧'}]},signal=new AbortController().signal
  const next=()=>({kind:'continue',messages:[base]})
  const context=await assemble(ctx,'fish',signal)
  const first=await step({agent,signal},next)
  assert.equal(first.messages.length,1);assert.match(context.contexts[0].text,/康德/)
  assert.match(context.contexts[0].text,/关于主人的观察/)
  const second=await step({agent,signal},()=>({...first}))
  assert.equal(second.messages.length,1)
  assert.equal((await assemble(ctx)).contexts[0].text,context.contexts[0].text)
  assert.equal((await assemble(ctx,'other')).contexts.length,0)
  assert.deepEqual(await step({agent:{session:{id:'other'}},signal},next),next())
  assert.equal((await step({agent,signal},()=>({kind:'reject'}))).kind,'reject')
  cfg.conceptSystem.mode='shadow';assert.equal((await assemble(ctx)).contexts.length,0)
  cfg.conceptSystem.learning=false;assert.deepEqual(await step({agent,signal},next),next())
  await learning.stop();assert.equal(ctx.hooks.get('agent/pre-step').length,0)
})

test('scheduler instructions, reasoning blocks and learned injections are never sources',async t=>{
  const store=new ObservationStore(box(t)),ctx=host(),observer=new Observer({store,paths:{}})
  const learning=createLearningHost({ctx,observer,config:()=>({conceptSystem:{observe:true}}),sessionIds:['fish'],start:false})
  const incoming=event(1,'user/message',{source:{kind:'user'},content:[{type:'text',text:'按夜间流程做'}]})
  await learning.onEvent({id:'fish'},incoming,{prepared:true})
  await learning.onEvent({id:'fish'},event(2,'user/message',{source:{kind:'bili-whale-learning-context'},content:[{type:'text',text:'学习素材'}]}))
  await learning.onEvent({id:'fish'},event(3,'assistant/message',{message:{source:{kind:'model'},content:[{type:'reasoning',text:'不能当成说过的话'}]}}))
  assert.equal(store.events({type:'learning.enqueued'}).length,0)
  await learning.stop()
})

test('external owner text is queued separately, deduplicated and not sent as extra host metadata',async t=>{
  const root=box(t),store=new ObservationStore(path.join(root,'evidence')),ctx=host(),observer=new Observer({store,paths:{}})
  const learning=createLearningHost({ctx,observer,config:()=>({conceptSystem:{observe:true}}),sessionIds:['fish'],start:false})
  const outgoing=[]
  const delivery=createSessionDelivery({controller:{create:async()=>({sessionId:'fish'}),prompt:async r=>outgoing.push(r)},dshHome:root,cwd:root,sessionId:'fish',config:()=>({}),persona:async()=>'',learning})
  const request={requestId:'receipt-1',sessionId:'fish',content:[{type:'text',text:'主人私信：包装提示'}]}
  await delivery.send(request,undefined,{learningSources:[source]});await delivery.send(request,undefined,{learningSources:[source]})
  assert.equal(store.events({type:'learning.enqueued'}).length,1)
  assert.equal(outgoing[0].learningSources,undefined)
  await learning.stop()
})

test('host adapter follows native LLM stream contract, isolates reasoning, and rejects truncation/tools',async()=>{
  let captured,config
  const ctx={llm:{async prepareCall(input,signal,select){config=select(input,{reasoning:{efforts:[{id:'low'}]}});return {config,async *stream(options){captured=options
    yield {type:'reasoning-delta',index:0,text:'reason'}
    yield {type:'block-end',index:0,block:{type:'reasoning',text:'reason'}}
    yield {type:'text-delta',index:1,text:'{"candidates":[]}'}
    yield {type:'block-end',index:1,block:{type:'text',text:'{"candidates":[]}'}}
    yield {type:'finish',reason:{kind:'stop'}}
  }}}}}
  const j={session_id:'fish',source,route},signal=new AbortController().signal
  const r=await evaluateWithHost(ctx,j,signal)
  assert.equal(r.text,'{"candidates":[]}');assert.equal(r.reasoning,'reason')
  assert.equal(config.maxTokens,3000);assert.equal(config.reasoningEffort,'low')
  assert.equal(captured.tools,undefined);assert.equal(captured.messages[0].source.kind,'bili-whale-learning-evaluation')
  for(const chunk of [{type:'finish',reason:{kind:'max-tokens'}},{type:'tool-call-delta'}]) {
    const bad={llm:{prepareCall:async()=>({config:route,async *stream(){yield chunk}})}}
    await assert.rejects(evaluateWithHost(bad,j,signal))
  }
  const aborted=new AbortController();aborted.abort()
  await assert.rejects(evaluateWithHost(ctx,j,aborted.signal))
})

test('pending jobs follow the current route while completed-turn jobs retain their route; foreign sessions stay untouched',async t=>{
  const store=new ObservationStore(box(t)),q=new LearningQueue(store)
  const a=await q.enqueue({session_id:'fish',source,route})
  const newer={provider:'new-provider',model:'new-model'}
  await q.route('fish',newer);assert.deepEqual(job(store,a.id).route,newer)
  await q.ready('fish');await q.route('fish',route);assert.deepEqual(job(store,a.id).route,newer)
  assert.equal(await q.claim(id=>id==='another-fish'),null)
  assert.equal(job(store,a.id).attempts,0)
})

test('actual fish speech enters learning separately, and newly learned fish material appears on the next step',async t=>{
  const store=new ObservationStore(box(t)),ctx=host(),observer=new Observer({store,paths:{}})
  const r=result();Object.assign(r.candidates[0],{subject:'fish',content:'慢慢来',quote:'慢慢来',tags:['phrase'],collections:['日常表达']})
  const learning=createLearningHost({ctx,observer,config:()=>({conceptSystem:{observe:true,learning:true,mode:'active',renderBudget:400}}),sessionIds:['fish'],start:false,evaluate:async()=>r})
  const step=ctx.hooks.get('agent/pre-step')[0],args={agent:{session:{id:'fish'}}},next=()=>({kind:'continue',messages:[]})
  assert.equal((await assemble(ctx)).contexts.length,0)
  await learning.onEvent({id:'fish'},event(1,'request/header',{header:{config:route}}))
  await learning.onEvent({id:'fish'},event(2,'assistant/message',{message:{source:{kind:'model'},content:[{type:'reasoning',text:'秘密推理'},{type:'text',text:'慢慢来，我们先试试看。'}]}}))
  await learning.onEvent({id:'fish'},event(3,'turn/end',{}));await learning.worker.wake()
  const after=await assemble(ctx)
  assert.equal(after.contexts.length,1);assert.match(after.contexts[0].text,/慢慢来/)
  assert.doesNotMatch(after.contexts[0].text,/秘密推理/)
  assert.equal((await step(args,next)).messages.length,0)
  assert.equal(Object.values(store.state().concepts.sources)[0].actor,'fish')
  await learning.stop()
})

test('learning errors cannot block ordinary model calls, but cancellation propagates',async t=>{
  const store=new ObservationStore(box(t)),ctx=host(),observer=new Observer({store,paths:{}})
  const learning=createLearningHost({ctx,observer,config:()=>({conceptSystem:{observe:true,learning:true,mode:'active',renderBudget:400}}),sessionIds:['fish'],start:false})
  store.snapshot=async()=>{throw Error('snapshot disk error')}
  const step=ctx.hooks.get('agent/pre-step')[0],decision={kind:'continue',messages:[]},args={agent:{session:{id:'fish'}}}
  assert.equal((await assemble(ctx)).contexts.length,0)
  assert.equal(await step(args,()=>decision),decision)
  assert.equal(store.events({type:'learning.context_failed'}).length,1)
  const abort=new AbortController();abort.abort()
  await assert.rejects(step({...args,signal:abort.signal},()=>decision))
  await assert.rejects(assemble(ctx,'fish',abort.signal))
  await learning.stop()
})

test('stopping evaluation cancels a hanging host call; no tool execution or completion is fabricated',async()=>{
  const parent=new AbortController()
  const ctx={llm:{prepareCall:()=>new Promise(()=>{})}}
  const promise=evaluateWithHost(ctx,{source,session_id:'fish',route},parent.signal)
  parent.abort(Error('plugin stopped'))
  await assert.rejects(promise,/plugin stopped/)
})

test('native runtime-context projection deduplicates snapshots and the learning hook cannot keep a completed turn alive',async t=>{
  const store=new ObservationStore(box(t)),ctx=host(),observer=new Observer({store,paths:{}})
  const learning=createLearningHost({ctx,observer,config:()=>({conceptSystem:{observe:true,learning:true,mode:'active',renderBudget:400}}),sessionIds:['fish'],start:false,evaluate:async()=>result()})
  await learning.worker.queue.enqueue({session_id:'fish',source,route});await learning.worker.queue.ready('fish');await learning.worker.wake()
  let retained
  // Contract from DSH agent-loop: project only a changed full snapshot; terminate
  // a completed turn when the next pre-step has no claimed/projected messages.
  const nativeDecision=async claimed=>{
    const assembly=await assemble(ctx),sections=assembly.contexts.map(({name,text})=>({name,text})).filter(s=>s.text.length)
    const snapshot='Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'+sections.map(s=>s.text).join('\n\n')
    const context=retained===snapshot?null:{id:'runtime-1',role:'user',source:{kind:'runtime-context',form:'snapshot',sections},content:[{type:'text',text:snapshot}]}
    const d={kind:'enter',messages:context?[...claimed,context]:claimed}
    const result=await ctx.hooks.get('agent/pre-step')[0]({agent:{session:{id:'fish'}},turn:1,step:1},()=>d)
    assert.equal(result,d)
    if(context) {
      retained=snapshot
      await learning.onEvent({id:'fish'},event(10,'user/message',context))
    }
    return result
  }
  assert.equal((await nativeDecision([{id:'user-1'}])).messages.length,2)
  assert.equal((await nativeDecision([])).messages.length,0)
  assert.equal(store.events({type:'learning.context_admitted'}).length,1)
  assert.equal(store.events({type:'learning.enqueued'}).length,1)
  await learning.stop()
})

test('a native runtime-context admission preserves the surrounding user trace',async t=>{
  const store=new ObservationStore(box(t)),ctx=host(),observer=new Observer({store,paths:{}})
  const adapter=attachSessionEvents(ctx,observer,'fish'),send=ctx.hooks.get('session/event')[0]
  send({id:'fish'},event(1,'user/message',{source:{kind:'user'},content:[{type:'text',text:'主人原话'}]}))
  send({id:'fish'},event(2,'user/message',{source:{kind:'runtime-context'},content:[{type:'text',text:'动态上下文'}]}))
  send({id:'fish'},event(3,'assistant/message',{message:{source:{kind:'model'},content:[{type:'text',text:'回答'}]}}))
  await adapter.stop()
  const rows=store.events({type:'host.session_event'})
  assert.ok(rows[0].trace_id)
  assert.equal(rows[1].trace_id,rows[0].trace_id)
  assert.equal(rows[2].trace_id,rows[0].trace_id)
})

test('provider delivery receipts require a real admission and an acknowledgement covering its host sequence',async t=>{
 const store=new ObservationStore(box(t)),ctx=host(),observer=new Observer({store,paths:{}})
 const learning=createLearningHost({ctx,observer,config:()=>({conceptSystem:{observe:true,learning:true,mode:'active',renderBudget:400}}),sessionIds:['fish'],start:false,evaluate:async()=>result()})
 t.after(()=>learning.stop())
 await learning.worker.queue.enqueue({session_id:'fish',source,route});await learning.worker.queue.ready('fish');await learning.worker.wake()
 await learning.onEvent({id:'fish'},event(1,'session-log-deepseek/delivery-accepted',{sessionId:'fish',throughSeq:100}))
 assert.equal(store.events({type:'learning.context_delivered'}).length,0)
 const assembly=await assemble(ctx),sections=assembly.contexts.map(({name,text})=>({name,text}))
 await learning.onEvent({id:'fish'},event(10,'user/message',{id:'real-runtime-message',source:{kind:'runtime-context',form:'snapshot',sections},content:[{type:'text',text:sections.map(s=>s.text).join('')}]}))
 await learning.onEvent({id:'fish'},event(11,'session-log-deepseek/delivery-accepted',{sessionId:'fish',throughSeq:9}))
 await learning.onEvent({id:'fish'},event(12,'session-log-deepseek/delivery-accepted',{sessionId:'other',throughSeq:20}))
 assert.equal(store.events({type:'learning.context_delivered'}).length,0)
 await learning.onEvent({id:'fish'},event(13,'session-log-deepseek/delivery-accepted',{sessionId:'fish',throughSeq:10}))
 await learning.onEvent({id:'fish'},event(14,'session-log-deepseek/delivery-accepted',{sessionId:'fish',throughSeq:20}))
 const receipts=store.events({type:'learning.context_delivered'});assert.equal(receipts.length,1)
 assert.equal(receipts[0].data.admission_host_seq,10);assert.equal(receipts[0].data.provider_through_seq,10)
 assert.ok(receipts[0].data.selected_member_ids.length>0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {ObservationStore,hash} from '../tools/lib/concept-system/store.mjs'
import {PersonaRevisions,PersonaRevisionWorker,readPersona,validateRevision,withPersonaLock} from '../tools/lib/concept-system/persona-revision.mjs'
import {LearningQueue} from '../tools/lib/concept-system/learning.mjs'
import {Observer} from '../tools/lib/concept-system/observation.mjs'
import {createLearningHost,evaluatePersonaWithHost} from '../lib/learning-host.js'
const base='# 我是谁\n\n我是鱼。\n\n# 怎么判断\n\n有证据再下判断。\n'
const route={provider:'fixture',model:'fixture'}
const feedback={id:'owner-feedback',actor:'user',type:'conversation',excerpt:'别只报完成，要说明问题还缺什么。',ref:'dm:actual'}
const fish1={id:'fish-1',actor:'fish',type:'conversation',excerpt:'这次读完了正文，但没有成本数据，原问题仍没有答案。',ref:'session:fish#1'}
const fish2={id:'fish-2',actor:'fish',type:'conversation',excerpt:'下一次应该找维护者的证词，不能只看演示成品。',ref:'session:fish#2'}
const patch=(sources=[feedback],trigger='feedback')=>({edits:[{before:'有证据再下判断。',after:'有证据再下判断。读完也不等于答完，要写清剩下的缺口。',reason:'真实反馈要求区分阅读完成与问题回答',trigger,evidence:sources.map(s=>({source_id:s.id,quote:s.excerpt}))}],reason:'把重复发生的反思固化为判断习惯'})
function box(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-persona-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new ObservationStore(path.join(root,'data')),file=path.join(root,'persona.md');fs.writeFileSync(file,base,{mode:0o600});return {store,file,manager:new PersonaRevisions({store,file})}}
async function done(store,source,session_id='fish'){const q=new LearningQueue(store);await q.enqueue({session_id,source,route});await q.ready(session_id);const j=await q.claim();await q.update(j,{status:'done'},'learning.completed')}
function host(){const hooks=new Map();return {hooks,on(k,fn){const rows=hooks.get(k)??[];rows.push(fn);hooks.set(k,rows);return ()=>hooks.set(k,(hooks.get(k)??[]).filter(x=>x!==fn))}}}
async function assemble(ctx,id='fish'){const a={contexts:[],sections:[],variables:route,tools:[]};return ctx.hooks.get('system-prompt/assemble')[0](a,{agent:{session:{id}}},()=>a)}

test('revision requires exact original spans and real evidence; video alone cannot create personal stance',()=>{
 assert.equal(validateRevision(patch(),base,[feedback]).text.includes('剩下的缺口'),true)
 assert.throws(()=>validateRevision(patch(),base,[]),/not in offered/)
 const wrong=patch();wrong.edits[0].before='不存在';assert.throws(()=>validateRevision(wrong,base,[feedback]),/exactly once/)
 assert.throws(()=>validateRevision(patch([fish1],'feedback'),base,[fish1]),/direct user/)
 assert.throws(()=>validateRevision(patch([fish1],'reflection'),base,[fish1]),/two independent/)
 const duplicate={...fish1,id:'other'};assert.throws(()=>validateRevision(patch([fish1,duplicate],'reflection'),base,[fish1,duplicate]),/two independent/)
 const video={...fish1,id:'video',actor:'third_party',type:'video'};assert.throws(()=>validateRevision(patch([video,fish1],'reflection'),base,[video,fish1]),/two independent/)
 assert.doesNotThrow(()=>validateRevision(patch([fish1,fish2],'reflection'),base,[fish1,fish2]))
})
test('atomic versioned edits and rollback preserve original sources and create auditable new versions',async t=>{
 const {store,file,manager}=box(t),next=validateRevision(patch(),base,[feedback])
 const revision=await manager.apply({expected_hash:hash(base),text:next.text,reason:next.reason,edits:next.edits,evidence:next.edits[0].evidence})
 assert.equal(fs.readFileSync(file,'utf8'),next.text);assert.equal(manager.status().history.length,1)
 assert.equal(store.getObject(revision.before_object).content,base)
 assert.equal((fs.statSync(file).mode&0o777),0o600)
 const rollback=await manager.rollback({revision_id:revision.id,expected_hash:hash(next.text),reason:'恢复原先表达'})
 assert.equal(fs.readFileSync(file,'utf8'),base);assert.equal(rollback.kind,'rollback');assert.equal(rollback.rollback_of,revision.id)
 assert.equal(manager.status().history.length,2);assert.equal(store.versions('persona').length,2)
 await assert.rejects(manager.rollback({revision_id:revision.id,expected_hash:hash(next.text),reason:'过时请求'}),/changed since/)
})
test('external edits, symlinks and competing file writers are preserved rather than overwritten',async t=>{
 const {file,manager}=box(t);fs.writeFileSync(file,base+'主人手工改动\n')
 await assert.rejects(manager.apply({expected_hash:hash(base),text:'覆盖',reason:'错误'}),/external edit preserved/)
 await withPersonaLock(file,async()=>{await assert.rejects(withPersonaLock(file,()=>{}),/writer busy/)})
 fs.unlinkSync(file);fs.symlinkSync('/etc/hosts',file);assert.throws(()=>readPersona(file),/regular file/)
})
test('a prepared write survives a crash before or after rename and never overwrites an external change',async t=>{
 for(const stage of ['before','after','external']){
  const {store,file,manager}=box(t),text=base+'\n新的判断习惯。\n',pending={id:'crash-'+stage,kind:'automatic',at:new Date().toISOString(),before_hash:hash(base),after_hash:hash(text),before_object:store.object(base).hash,after_object:store.object(text).hash,reason:'已归档',evidence:[]}
  await store.transaction({},d=>{d.state.persona_revision={schema:1,history:[],seen:[],pending}})
  if(stage==='after')fs.writeFileSync(file,text)
  if(stage==='external')fs.writeFileSync(file,base+'手工改动')
  if(stage==='external'){await assert.rejects(manager.recover(),/external edit preserved/);assert.match(fs.readFileSync(file,'utf8'),/手工改动/)}else{await manager.recover();assert.equal(fs.readFileSync(file,'utf8'),text);assert.equal(manager.status().history.length,1);await manager.recover();assert.equal(manager.status().history.length,1)}
 }
})
test('automatic idle worker consumes real completed jobs, saves request/response/reason and does not repeat',async t=>{
 const {store,file,manager}=box(t);await done(store,fish1);await done(store,fish2)
 let calls=0,idle=false
 const w=new PersonaRevisionWorker({store,file,idle:()=>idle,evaluate:async req=>{calls++;assert.equal(req.base.text,base);assert.deepEqual(req.sources.map(s=>s.id),[fish1.id,fish2.id]);return patch(req.sources,'reflection')}})
 await w.wake();assert.equal(calls,0);idle=true;await w.wake();assert.equal(calls,1)
 assert.match(fs.readFileSync(file,'utf8'),/剩下的缺口/);await w.wake();assert.equal(calls,1)
 const history=manager.status().history[0];assert.equal(history.evidence.length,2);assert.ok(history.idempotency_key)
 assert.equal(store.events({type:'persona.reflection_requested'}).length,1);assert.equal(store.events({type:'persona.reflection_response'}).length,1)
 await w.stop()
})
test('startup history is bounded and no-op reflection leaves persona and versions unchanged',async t=>{
 const {store,file}=box(t)
 for(let i=0;i<24;i++)await done(store,{...fish1,id:'fish-'+i,excerpt:fish1.excerpt+i})
 let offered
 const w=new PersonaRevisionWorker({store,file,evaluate:async req=>{offered=req.sources;return {edits:[],reason:'当前规则已覆盖经历'}}})
 await w.wake();await w.stop();assert.equal(offered.length,20);assert.equal(fs.readFileSync(file,'utf8'),base)
 assert.equal(store.events({type:'persona.revision_applied'}).length,0);assert.equal(store.state().persona_revision.seen.length,24)
})
test('a foreground turn defers validated reflection; recovery applies saved result without reinference',async t=>{
 const {store,file}=box(t);await done(store,feedback)
 let idle=true,calls=0
 const w=new PersonaRevisionWorker({store,file,idle:()=>idle,evaluate:async()=>{calls++;idle=false;return patch()}})
 await w.wake();assert.equal(fs.readFileSync(file,'utf8'),base);assert.ok(store.state().persona_revision.attempt.evaluation)
 idle=true;await w.wake();assert.equal(calls,1);assert.match(fs.readFileSync(file,'utf8'),/剩下的缺口/);await w.stop()
})
test('separate workers lease one inference and an applied revision is idempotent across completion recovery',async t=>{
 const {store,file,manager}=box(t);await done(store,feedback)
 let release,entered;const wait=new Promise(r=>{release=r}),started=new Promise(r=>{entered=r})
 const a=new PersonaRevisionWorker({store,file,evaluate:async()=>{entered();await wait;return patch()}})
 const run=a.wake();await started
 const b=new PersonaRevisionWorker({store,file,evaluate:()=>assert.fail('lease must prevent competing inference')});await b.wake();release();await run
 assert.equal(manager.status().history.length,1)
 const old=manager.status().history[0]
 await manager.apply({expected_hash:old.before_hash,text:'must not overwrite',reason:'resume',idempotency_key:old.idempotency_key})
 assert.match(fs.readFileSync(file,'utf8'),/剩下的缺口/);assert.equal(manager.status().history.length,1)
 await a.stop();await b.stop()
})
test('failed inference backs off, stop aborts, disabled and unrelated sources cannot write',async t=>{
 const {store,file}=box(t);await done(store,feedback,'other')
 let calls=0
 const w=new PersonaRevisionWorker({store,file,acceptSession:id=>id==='fish',evaluate:async()=>{calls++;throw Error('truncated')}})
 await w.wake();assert.equal(calls,0);await done(store,feedback)
 w.enabled=()=>false;await w.wake();assert.equal(calls,0);w.enabled=()=>true;await w.wake();await w.wake();assert.equal(calls,1)
 assert.equal(fs.readFileSync(file,'utf8'),base);assert.equal(store.state().persona_revision.attempt.error,'truncated');await w.stop()
})
test('native auxiliary LLM contract receives actual persona and sources and rejects tool output',async()=>{
 let offered
 const ctx={llm:{prepareCall:async()=>({config:{},async *stream(o){offered=o;yield {type:'block-end',index:0,block:{type:'text',text:JSON.stringify(patch())}};yield {type:'finish',reason:{kind:'stop'}}}})}}
 const response=await evaluatePersonaWithHost(ctx,{base:{text:base,hash:hash(base)},sources:[feedback],route,session_id:'fish'},new AbortController().signal)
 assert.equal(offered.purpose,'bili-whale-persona-reflection');assert.equal(JSON.parse(offered.messages[0].content[0].text).sources[0].id,feedback.id)
 assert.equal(JSON.parse(response.text).edits.length,1);assert.equal(offered.tools,undefined)
})
test('revised persona enters direct-request runtime context and only real provider coverage proves delivery',async t=>{
 const {store,file,manager}=box(t),ctx=host();await done(store,feedback)
 const learning=createLearningHost({ctx,observer:new Observer({store,paths:{}}),config:()=>({conceptSystem:{observe:true,learning:true,mode:'active',renderBudget:400}}),sessionIds:['fish'],personaRevision:true,personaFile:file,revise:async()=>patch(),start:false})
 await learning.revision.wake();const latest=manager.status().history[0]
 const a=await assemble(ctx);const section=a.contexts.find(c=>c.name==='bili-whale-persona-context');assert.match(section.text,/剩下的缺口/)
 assert.equal((await assemble(ctx,'other')).contexts.length,0)
 await learning.onEvent({id:'fish'},{type:'user/message',seq:10,data:{source:{kind:'runtime-context',sections:[section]},id:'persona-context'}})
 await learning.onEvent({id:'fish'},{type:'session-log-deepseek/delivery-accepted',seq:11,data:{sessionId:'fish',throughSeq:9}})
 assert.equal(store.events({type:'persona.context_delivered'}).length,0)
 await learning.onEvent({id:'fish'},{type:'session-log-deepseek/delivery-accepted',seq:12,data:{sessionId:'fish',throughSeq:10}})
 const delivered=store.events({type:'persona.context_delivered'})[0];assert.equal(delivered.data.revision_id,latest.id);assert.equal(delivered.data.hash,latest.after_hash)
 assert.equal(store.events({type:'learning.enqueued'}).length,1,'runtime context must not self-learn')
 await learning.stop()
})
test('one new experience can compare against prior reflections without re-consuming old jobs',async t=>{
 const {store,file}=box(t);await done(store,fish1);await done(store,fish2)
 let calls=0,last
 const w=new PersonaRevisionWorker({store,file,evaluate:async req=>{calls++;last=req.sources;return {edits:[],reason:'已有规则足够'}}})
 await w.wake();const third={...fish1,id:'fish-3',excerpt:'今天的材料还是只展示成品，下一次要找维护记录。'};await done(store,third);await w.wake();await w.stop()
 assert.equal(calls,2);assert.equal(last.length,3);assert.ok(last.some(s=>s.id===fish2.id));assert.equal(store.state().persona_revision.seen.length,3)
 assert.equal(store.events({type:'persona.revision_applied'}).length,0)
})
test('explicit retry retains failed evidence and counters and lets the ordinary worker reassess original sources',async t=>{
 const {store,file,manager}=box(t);await done(store,feedback)
 let now=0
 const w=new PersonaRevisionWorker({store,file,now:()=>now,evaluate:async()=>{throw Error('needs correction')}})
 await w.wake();now=60001;await w.wake();now=120002;await w.wake();await w.stop()
 const failed=manager.status().failures[0];assert.ok(failed)
 await assert.rejects(manager.retry({attempt_id:failed.attempt_id,expected_hash:hash('wrong'),reason:'纠正协议后重试'}),/changed/)
 const retry=await manager.retry({attempt_id:failed.attempt_id,expected_hash:hash(base),reason:'纠正协议后重试'})
 assert.equal(retry.retry_of,failed.attempt_id);assert.equal(fs.readFileSync(file,'utf8'),base)
 const next=new PersonaRevisionWorker({store,file,evaluate:async req=>{assert.equal(req.sources[0].id,feedback.id);assert.equal(req.previous_error,'needs correction');return patch()}})
 await next.wake();await next.stop();assert.match(fs.readFileSync(file,'utf8'),/剩下的缺口/)
 assert.equal(store.events({type:'persona.reflection_failed'}).length,3);assert.equal(store.events({type:'persona.reflection_retried'}).length,1)
 assert.equal(store.events({type:'learning.enqueued'}).length,1,'retry does not create a fake experience')
})

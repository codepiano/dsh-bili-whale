import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {ObservationStore,hash} from '../tools/lib/concept-system/store.mjs'
import {Observer} from '../tools/lib/concept-system/observation.mjs'
import {VideoReads,videoMaterial} from '../tools/lib/concept-system/video-reads.mjs'
import {LearningQueue,LearningWorker,validateEvaluation} from '../tools/lib/concept-system/learning.mjs'
import {FeedConcepts} from '../tools/lib/concept-system/feed.mjs'
import {ConceptEngine} from '../tools/lib/concept-system/engine.mjs'
import {createLearningHost} from '../lib/learning-host.js'

const bv='BV1234567890',route={provider:'fixture',model:'fixture'}
const packet=(over={})=>({bvid:bv,cid:'123',title:'康德导读',description:'视频简介',duration:90,subtitles:[{from:0,to:4,content:'康德讨论认识的边界。'}],...over})
const evaluation=(catalog)=>({candidates:[{subject:'fish',content:'康德',tags:['topic'],scene:'general',triggers:[],exclusions:[],interpretation:'mention',quote:'康德',status:'accepted',reason:'字幕中出现的话题，不表示认同',collections:[catalog?.inventory.find(c=>c.subject==='fish'&&c.name==='哲学') ? {collection_id:catalog.inventory.find(c=>c.subject==='fish'&&c.name==='哲学').id,reason:'复用已有哲学群'} : {name:'哲学',definition:'哲学相关概念',boundary:'不据此推断个人认同',aliases:[],related:[],reason:'来源属于这一主题'}]}]})
function box(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'whale-debrief-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}
function setup(t){const store=new ObservationStore(box(t));return {store,reads:new VideoReads(store)}}
async function capture(reads,over={}){const read=await reads.start(bv);return reads.complete(read.id,packet(over))}
function host(){const hooks=new Map();return {hooks,on(k,fn){hooks.set(k,fn);return ()=>hooks.delete(k)}}}
const tool=marker=>({type:'tool/result',seq:5,data:{message:{id:'tool-1',source:{kind:'tool',callId:'call-1'},content:[{type:'text',text:marker}]}}})

test('acquired, presented and assessed are distinct; successful learning produces new feed interest without rewards',async t=>{
  const {store,reads}=setup(t),receipt=await capture(reads)
  assert.equal((await reads.get(receipt.id)).status,'acquired');assert.deepEqual(reads.seen(),[])
  assert.equal(store.events({type:'learning.enqueued'}).length,0)
  const ctx=host(),cfg={conceptSystem:{observe:true,learning:true,mode:'active',renderBudget:400}}
  const learning=createLearningHost({ctx,observer:new Observer({store,paths:{}}),config:()=>cfg,sessionIds:['fish'],start:false,evaluate:async job=>{
    assert.equal(job.source.actor,'third_party');assert.equal(job.source.type,'video');assert.equal(job.source.video.bvid,bv)
    return evaluation()
  }})
  await learning.onEvent({id:'fish'},{type:'request/header',data:{header:{config:route}}})
  await learning.onEvent({id:'fish'},tool(receipt.marker),{trace_id:'host-trace'})
  assert.equal((await reads.get(receipt.id)).status,'presented');assert.deepEqual(reads.seen(),[bv])
  assert.equal(store.events({type:'candidate.proposed'}).length,0)
  await learning.onEvent({id:'fish'},{type:'turn/end',data:{}});await learning.worker.wake()
  assert.equal((await reads.get(receipt.id)).status,'assessed')
  const source=Object.values(store.state().concepts.sources)[0]
  assert.equal(source.video.section,'subtitles');assert.equal(source.ref,'bili:'+bv)
  const collection=Object.values(store.state().concepts.collections)[0]
  assert.equal(collection.reward,0);assert.equal(collection.affinity,0)
  const feed=new FeedConcepts({config:cfg,store,runId:'after-reading'})
  assert.ok((await feed.plan(['AI'])).keywords.includes('康德'))
  const known={bv:'BV0000000001',t:'康德的认识论',_score:0,_hits:[]},old={bv:'BV0000000002',t:'AI',_score:20,_hits:['AI']}
  assert.equal((await feed.select({candidates:[old,known],legacy:[old,known],n:1,per:2})).selected[0].bv,known.bv)
  await learning.stop()
})

test('unbound, forged, failed-tool and unrelated-session markers cannot enqueue sources',async t=>{
  const {store,reads}=setup(t),receipt=await capture(reads),ctx=host()
  const learning=createLearningHost({ctx,observer:new Observer({store,paths:{}}),config:()=>({conceptSystem:{observe:true,learning:true}}),sessionIds:['fish'],start:false})
  await learning.onEvent({id:'other'},tool(receipt.marker))
  await learning.onEvent({id:'fish'},{...tool(receipt.marker),data:{...tool(receipt.marker).data,error:{message:'failed'}}})
  await learning.onEvent({id:'fish'},tool(receipt.marker.replace(receipt.material_hash,'a'.repeat(64))))
  assert.equal(store.events({type:'learning.enqueued'}).length,0);assert.deepEqual(reads.seen(),[])
  await reads.acceptOutput(receipt.marker,{session_id:'fish',route})
  await reads.acceptOutput(receipt.marker,{session_id:'other',route})
  assert.equal((await reads.get(receipt.id)).session_id,'fish')
  assert.equal(store.events({type:'learning.enqueued'}).length,1)
  assert.equal(store.events({type:'video.receipt_rejected'}).length,1)
  await learning.stop()
})

test('repeated shallow/deep content reuses assessed sources; changed subtitles retain provenance and require fresh assessment',async t=>{
  const {store,reads}=setup(t),worker=new LearningWorker({store,evaluate:async job=>evaluation(job.catalog)})
  const first=await capture(reads);await reads.acceptOutput(first.marker,{session_id:'fish',route});await worker.queue.ready('fish');await worker.wake()
  const state=hash(store.state()),second=await capture(reads,{artifacts:{sheet:'/fixture/sheet.jpg'}})
  await reads.acceptOutput(second.marker,{session_id:'fish',route})
  assert.equal((await reads.get(second.id)).status,'assessed');assert.equal(hash(store.state()),state)
  assert.equal(store.events({type:'learning.enqueued'}).length,1)
  const changed=await capture(reads,{subtitles:[{from:0,to:4,content:'康德与判断力的新段落。'}]})
  await reads.acceptOutput(changed.marker,{session_id:'fish',route})
  assert.equal((await reads.get(changed.id)).status,'presented')
  assert.equal(store.events({type:'learning.enqueued'}).length,2)
  await worker.queue.ready('fish');await worker.wake()
  assert.equal((await reads.get(changed.id)).status,'assessed')
  assert.equal(new Set(Object.values(store.state().concepts.sources).map(s=>s.ref)).size,1)
  await worker.stop()
})

test('metadata-only and empty/failed acquisitions never become full content reads',async t=>{
  const {reads,store}=setup(t)
  const description=await capture(reads,{subtitles:[],description:'康德简介'})
  await reads.acceptOutput(description.marker,{session_id:'fish',route})
  assert.equal((await reads.get(description.id)).kind,'description');assert.deepEqual(reads.seen(),[])
  const empty=await capture(reads,{subtitles:[],description:''});await reads.acceptOutput(empty.marker,{session_id:'fish',route})
  assert.equal((await reads.get(empty.id)).kind,'none');assert.equal((await reads.get(empty.id)).sources.length,0)
  const failed=await reads.start(bv);await reads.fail(failed.id,Error('HTTP 412'))
  assert.equal((await reads.get(failed.id)).status,'failed');assert.equal(store.events({type:'learning.enqueued'}).length,1)
})

test('long subtitle content is chunked with coverage and remains partially assessed until every part completes',async t=>{
  const {reads,store}=setup(t),long=Array.from({length:12},(_,i)=>({from:i*10,to:i*10+8,content:'康德'+String(i)+'讨论'.repeat(1800)}))
  const receipt=await capture(reads,{subtitles:long}),data=await reads.get(receipt.id)
  assert.ok(data.sources.length>4)
  await reads.acceptOutput(receipt.marker,{session_id:'fish',route})
  const worker=new LearningWorker({store,evaluate:async()=>({candidates:[]})})
  await worker.queue.ready('fish');await worker.wake()
  assert.equal((await reads.get(receipt.id)).status,'presented');assert.equal((await reads.get(receipt.id)).parts_assessed,4)
  while((await reads.get(receipt.id)).status!=='assessed')await worker.wake()
  assert.equal((await reads.get(receipt.id)).parts_assessed,data.sources.length)
  const limited=videoMaterial(packet({subtitles:Array.from({length:100},(_,i)=>({from:i,to:i+1,content:'文'.repeat(4000)}))}))
  assert.equal(limited.sources.length,24);assert.equal(limited.coverage.truncated,true)
  assert.ok(limited.sources.every(s=>s.excerpt.length<=8000))
  assert.equal(videoMaterial(packet({subtitles:[{from:0,content:'字'.repeat(5000)}]})).coverage.truncated,true)
  await worker.stop()
})

test('third-party content cannot become endorsed beliefs, motives or user interests',()=>{
  const source=videoMaterial(packet()).sources[0]
  assert.doesNotThrow(()=>validateEvaluation(evaluation(),source))
  for(const patch of [{tags:['belief']},{tags:['motive']},{subject:'user'},{interpretation:'explicit'},{quote:'编造的原文'}]) {
    const value=evaluation();Object.assign(value.candidates[0],patch);assert.throws(()=>validateEvaluation(value,source))
  }
  const neg=evaluation();Object.assign(neg.candidates[0],{interpretation:'negated',status:'deferred',collections:[]})
  assert.doesNotThrow(()=>validateEvaluation(neg,source))
})

test('pausing learning still records receipt delivery; reenabling resumes assessment automatically',async t=>{
  const {store,reads}=setup(t),receipt=await capture(reads),ctx=host(),cfg={conceptSystem:{observe:true,learning:false}}
  let calls=0
  const learning=createLearningHost({ctx,observer:new Observer({store,paths:{}}),config:()=>cfg,sessionIds:['fish'],start:false,evaluate:async()=>{calls++;return evaluation()}})
  await learning.onEvent({id:'fish'},{type:'request/header',data:{header:{config:route}}})
  await learning.onEvent({id:'fish'},tool(receipt.marker));await learning.onEvent({id:'fish'},{type:'turn/end',data:{}})
  assert.equal((await reads.get(receipt.id)).status,'presented');assert.equal(calls,0);assert.deepEqual(reads.seen(),[bv])
  cfg.conceptSystem.learning=true
  await learning.onEvent({id:'fish'},{type:'turn/end',data:{}});await learning.worker.wake()
  assert.equal(calls,1);assert.equal((await reads.get(receipt.id)).status,'assessed')
  await learning.stop()
})

test('feed run association is explicit and validated; read events link the correct decision',async t=>{
  const {store,reads}=setup(t),engine=new ConceptEngine(store)
  const m=await engine.call('concept_propose',{key:'init',source:{id:'fish',actor:'fish',type:'conversation',excerpt:'康德'},subject:'fish',content:'康德',tags:['topic']})
  await engine.call('concept_review',{key:'init',candidate_id:m.id,status:'accepted',reason:'fixture',collections:[{name:'哲学'}]})
  const v={bv,t:'康德',_hits:[],_score:0},feed=new FeedConcepts({config:{conceptSystem:{observe:true,mode:'active'}},store,runId:'night'})
  const slate=await feed.select({candidates:[v],legacy:[v],n:1,per:2})
  await assert.rejects(reads.start('BV0000000001',{feed_run_id:'night'}),/not in/)
  const attempt=await reads.start(bv,{feed_run_id:'night'}),receipt=await reads.complete(attempt.id,packet())
  assert.equal((await reads.get(receipt.id)).feed.decision_id,slate.decisions[0].id)
  assert.ok(store.events({decision_id:slate.decisions[0].id}).some(e=>e.type==='video.material_acquired'))
  const failed=await reads.start(bv,{feed_run_id:'night'});await reads.fail(failed.id,Error('fixture network failure'))
  assert.ok(store.events({decision_id:slate.decisions[0].id}).some(e=>e.type==='video.read_failed'))
})

test('corrupt material objects roll back receipt admission and all queue bindings',async t=>{
  const {store,reads}=setup(t),receipt=await capture(reads),record=await reads.get(receipt.id)
  const file=path.join(store.directory,'objects',record.sources[0].object.hash+'.json'),original=fs.readFileSync(file)
  fs.writeFileSync(file,'corrupted source')
  await assert.rejects(reads.acceptOutput(receipt.marker,{session_id:'fish',route}))
  assert.equal((await reads.get(receipt.id)).status,'acquired');assert.equal(store.events({type:'learning.enqueued'}).length,0)
  fs.writeFileSync(file,original)
  await reads.acceptOutput(receipt.marker,{session_id:'fish',route});assert.equal(store.events({type:'learning.enqueued'}).length,1)
})

test('failed evaluations stay visibly failed and never claim the video assessment completed',async t=>{
  let now=1000
  const store=new ObservationStore(box(t),{now:()=>now}),reads=new VideoReads(store),receipt=await capture(reads)
  await reads.acceptOutput(receipt.marker,{session_id:'fish',route})
  const worker=new LearningWorker({store,evaluate:async()=>{const r=evaluation();r.candidates[0].interpretation='explicit';return r}})
  await worker.queue.ready('fish');await worker.wake();now+=30000;await worker.wake();now+=60000;await worker.wake()
  const read=await reads.get(receipt.id)
  assert.equal(read.status,'presented');assert.equal(read.parts_failed,1);assert.equal(read.parts_assessed,0)
  assert.equal(store.events({type:'video.assessed'}).length,0);assert.equal(store.events({type:'candidate.proposed'}).length,0)
  await worker.stop()
})

test('fresh feed exposes presented subtitle reads to its exclusion gate',async t=>{
  const {store,reads}=setup(t),receipt=await capture(reads)
  const feed=new FeedConcepts({config:{conceptSystem:{observe:true,mode:'active'}},store,runId:'fresh'})
  assert.deepEqual(feed.readBvids(),[])
  await reads.acceptOutput(receipt.marker,{session_id:'fish',route})
  assert.deepEqual(feed.readBvids(),[bv])
})

function cliBox(t,fixture,observe=true) {
  const home=box(t),profile=path.join(home,'profile'),privateDir=path.join(home,'.bili-ai'),concept=path.join(home,'concepts')
  fs.mkdirSync(profile);fs.mkdirSync(privateDir)
  const config=path.join(profile,'config.json'),data=path.join(home,'fixture.json'),requests=path.join(home,'requests.jsonl')
  fs.writeFileSync(config,JSON.stringify({conceptSystem:{observe,learning:true,mode:'active'},reading:fixture.reading??{},risk:{minGapMs:0}}));fs.writeFileSync(data,JSON.stringify(fixture))
  fs.writeFileSync(path.join(privateDir,'credentials.json'),JSON.stringify({sessdata:'fixture',bili_jct:'fixture',buvid3:'fixture'}))
  const env={...process.env,HOME:home,USERPROFILE:home,DSH_HOME:profile,BILI_WHALE_CONFIG:config,BILI_CONCEPT_HOME:concept,BILI_NO_CACHE:'1',TEST_DEBRIEF_FIXTURE:data,TEST_REQUESTS:requests,
    NODE_OPTIONS:'--import='+pathToFileURL(fileURLToPath(new URL('./helpers/debrief-fetch.mjs',import.meta.url))).href}
  return {concept,requests,env,run:(args=[])=>spawnSync(process.execPath,[fileURLToPath(new URL('../tools/commands/debrief.mjs',import.meta.url)),bv,'--no-frames',...args],{env,encoding:'utf8',timeout:15000})}
}

test('real debrief CLI records text independently of missing cover, then host receipt feeds learning',async t=>{
  const s=cliBox(t,{cover_failed:true}),result=s.run(['--context']);assert.ifError(result.error);assert.equal(result.status,0,result.stderr)
  const marker=result.stdout.match(/BILI_DEBRIEF_RECEIPT:[a-f0-9-]+:[a-f0-9]+/)[0]
  const reads=new VideoReads(new ObservationStore(s.concept));await reads.acceptOutput(marker,{session_id:'fish',route})
  const record=(await reads.store.events({type:'video.material_acquired'}))[0]
  const material=reads.store.getObject(record.data.object.hash).content
  assert.equal(material.components.cover,'failed');assert.equal(material.components.subtitles,'success');assert.equal(material.track.automatic,true)
  assert.deepEqual(reads.seen(),[bv]);assert.equal(reads.store.events({type:'learning.enqueued'}).length,1)
  assert.ok(fs.readFileSync(s.requests,'utf8').split('\n').filter(Boolean).every(l=>JSON.parse(l).method==='GET'))
})

test('real CLI metadata failure has no success receipt or learning source; disabled observation creates no learning database',async t=>{
  const bad=cliBox(t,{view_code:-404}),r=bad.run();assert.equal(r.status,3,r.stdout+r.stderr);assert.doesNotMatch(r.stdout,/BILI_DEBRIEF_RECEIPT/)
  const store=new ObservationStore(bad.concept);assert.equal(store.events({type:'video.read_failed'}).length,1);assert.equal(store.events({type:'learning.enqueued'}).length,0)
  const disabled=cliBox(t,{},false),off=disabled.run();assert.equal(off.status,0,off.stderr);assert.doesNotMatch(off.stdout,/BILI_DEBRIEF_RECEIPT/);assert.equal(fs.existsSync(disabled.concept),false)
})

test('real CLI subtitle failures retain description provenance without claiming a text-content read',async t=>{
  const s=cliBox(t,{subtitle_failed:true}),r=s.run();assert.equal(r.status,0,r.stderr)
  const marker=r.stdout.match(/BILI_DEBRIEF_RECEIPT:[a-f0-9-]+:[a-f0-9]+/)[0]
  const reads=new VideoReads(new ObservationStore(s.concept));await reads.acceptOutput(marker,{session_id:'fish',route})
  const id=marker.split(':')[1],record=await reads.get(id),material=reads.store.getObject(record.material.hash).content
  assert.equal(record.kind,'description');assert.equal(material.components.subtitles,'failed');assert.deepEqual(reads.seen(),[])
  assert.equal(reads.store.getObject(record.sources[0].object.hash).content.video.section,'description')
})


test('default CLI fetches only metadata and subtitles, preferring human zh-CN over AI tracks',async t=>{
  const s=cliBox(t,{multiple_tracks:true}),r=s.run();assert.equal(r.status,0,r.stderr)
  const urls=fs.readFileSync(s.requests,'utf8').trim().split('\n').map(l=>JSON.parse(l).url)
  assert.ok(!urls.some(u=>/cover|comment|reply|playurl/.test(u)))
  const id=r.stdout.match(/BILI_DEBRIEF_RECEIPT:([^:]+):/)[1],store=new ObservationStore(s.concept),row=await new VideoReads(store).get(id)
  const material=store.getObject(row.material.hash).content
  assert.equal(material.track.language,'zh-CN');assert.equal(material.track.automatic,false)
  assert.equal(material.components.cover,'skipped');assert.equal(material.components.audio,'skipped')
})

test('CLI stages audio for cloud speech without launching local ASR',async t=>{
  const speech={baseUrl:'http://127.0.0.1:4325/api/',provider:'doubao'}
  const s=cliBox(t,{no_subtitles:true,reading:{audio:speech}});s.env.BILI_SPEECH_TOKEN='fixture-speech-token'
  s.env.FFMPEG='/not-allowed/ffmpeg';s.env.BILI_WHISPER_BIN='/not-allowed/whisper'
  const r=s.run();assert.equal(r.status,0,r.stderr)
  const id=r.stdout.match(/BILI_AUDIO_PENDING:([^\s]+)/)?.[1];assert.ok(id,r.stdout)
  assert.doesNotMatch(r.stdout,/BILI_DEBRIEF_RECEIPT/)
  const store=new ObservationStore(s.concept),row=await new VideoReads(store).get(id)
  assert.equal(row.status,'audio_pending');assert.equal(row.kind,'none')
  const requests=fs.readFileSync(s.requests,'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(requests.some(r=>r.url.endsWith('/api/transcriptions')&&r.method==='POST'))
  assert.equal(requests.filter(r=>new URL(r.url).hostname==='fixture.bilivideo.com').length,1,'local host only transfers compressed audio to managed staging')
  assert.ok(requests.some(r=>r.url.endsWith('/api/audio-uploads')))
  assert.ok(requests.some(r=>r.url.startsWith('https://fixture.tos-cn-beijing.volces.com/')))
  assert.ok(!requests.some(r=>/cover|comment|reply/.test(r.url)))
  assert.equal(store.events({type:'learning.enqueued'}).length,0)
  const never=cliBox(t,{no_subtitles:true,reading:{audio:speech}});never.env.BILI_SPEECH_TOKEN='fixture-speech-token'
  assert.equal(never.run(['--audio','never']).status,0)
  assert.doesNotMatch(fs.readFileSync(never.requests,'utf8'),/playurl|transcriptions/)
})

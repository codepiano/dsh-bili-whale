import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {ObservationStore,hash} from '../tools/lib/concept-system/store.mjs'
import {ConceptEngine} from '../tools/lib/concept-system/engine.mjs'
import {VideoReads} from '../tools/lib/concept-system/video-reads.mjs'
import {FeedConcepts,feedGroups,interestPlan,videoContributions} from '../tools/lib/concept-system/feed.mjs'

function box(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'whale-feed-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}
async function topic(engine,name,{subject='fish',tags=['topic'],scene='general',interpretation='explicit',exclusions=[]}={}) {
  const key=subject+name+tags.join(',')+scene
  const m=await engine.call('concept_propose',{key,source:{id:key,actor:subject,type:'conversation',excerpt:name,ref:'source:'+key},subject,content:name,tags,scene,interpretation,exclusions})
  return engine.call('concept_review',{key,candidate_id:m.id,status:'accepted',reason:'fixture explicit evidence',collections:[{name}]})
}
const cfg=mode=>({conceptSystem:{observe:true,mode}})
const video=(n,t,score=0)=>({bv:'BV'+String(n).padStart(10,'0'),t,d:300,dm:30,play:1000,up:'UP',kw:'fallback',_hits:[],_score:score})
async function fixture(t){const store=new ObservationStore(box(t)),engine=new ConceptEngine(store);await topic(engine,'猫');await topic(engine,'康德');return {store,engine}}

test('active interests change search terms and actual videos; owner interests and expression-only groups do not compete',async t=>{
  const {store,engine}=await fixture(t)
  await topic(engine,'股票',{subject:'user'});await topic(engine,'慢慢来',{tags:['phrase']});await topic(engine,'旅游',{scene:'reply'})
  const selector=new FeedConcepts({config:cfg('active'),store,runId:'active',seed:'seed'})
  const plan=await selector.plan(['AI','动漫'])
  assert.ok(plan.keywords.includes('猫'));assert.ok(plan.keywords.includes('康德'));assert.ok(plan.keywords.includes('AI'))
  assert.ok(!plan.keywords.includes('股票'));assert.ok(!plan.keywords.includes('慢慢来'));assert.ok(!plan.keywords.includes('旅游'))
  const old=video(1,'AI 高弹幕候选',50),cat=video(2,'猫的日常'),owner=video(3,'股票入门')
  const result=await selector.select({candidates:[old,cat,owner],legacy:[old,owner,cat],n:1,per:2})
  assert.equal(result.selected[0].bv,cat.bv)
  assert.equal(result.decisions.length,1)
  assert.equal((await engine.call('decision_replay',{preview_id:result.decisions[0].preview_id})).matches,true)
  assert.equal(Object.values(store.state().concepts.collections).find(c=>c.subject==='user').fatigue.feed,undefined)
})

test('selection fatigue changes the next chosen video, decays with time, and does not reward a winner',async t=>{
  let now=1000
  const store=new ObservationStore(box(t),{now:()=>now}),engine=new ConceptEngine(store)
  await topic(engine,'猫');await topic(engine,'康德')
  const candidates=[video(1,'猫的日常'),video(2,'康德入门')]
  const select=runId=>new FeedConcepts({config:cfg('active'),store,runId,seed:'same'}).select({candidates,legacy:candidates,n:1,per:2})
  const first=await select('first'),second=await select('second')
  assert.notEqual(first.selected[0].bv,second.selected[0].bv)
  assert.equal(first.decisions[0].fatigue_changes[0].after,0.2)
  now+=60*3600000
  const recovered=await select('recovered')
  assert.equal(recovered.selected[0].bv,first.selected[0].bv)
  assert.ok(Object.values(store.state().concepts.collections).every(c=>c.reward===0))
})

test('fatigue changes which interest search terms enter the limited query budget',async t=>{
  const store=new ObservationStore(box(t)),engine=new ConceptEngine(store)
  for(const name of ['猫','康德','佛教','动漫','纪录片'])await topic(engine,name)
  const state=store.state().concepts,now=store.now(),before=interestPlan(state,'search-budget',now)
  const winner=Object.values(state.collections).find(c=>c.name===before.keywords[0])
  winner.fatigue.feed={value:0.9,at:now}
  const after=interestPlan(state,'search-budget',now)
  assert.equal(before.keywords.length,4);assert.equal(after.keywords.length,4)
  assert.ok(!after.keywords.includes(before.keywords[0]))
  assert.notDeepEqual(after.keywords,before.keywords)
})

test('title matching respects English boundaries, collection names and explicit exclusion triggers',async t=>{
  const store=new ObservationStore(box(t)),engine=new ConceptEngine(store)
  const item=await topic(engine,'AI',{exclusions:['广告']})
  const groups=feedGroups(store.state().concepts)
  assert.equal(videoContributions(video(1,'chair review'),groups).length,0)
  assert.equal(videoContributions(video(2,'AI 工具'),groups).length,1)
  assert.equal(videoContributions(video(3,'AI 广告'),groups).length,0)
  await engine.call('concept_review',{key:'broader',candidate_id:item.member.id,status:'accepted',reason:'归入宽泛主题',collections:[{name:'人工智能'}]})
  const matches=videoContributions(video(4,'人工智能入门'),feedGroups(store.state().concepts))
  assert.equal(matches.length,1);assert.match(matches[0].reason,/人工智能/)
})

test('new members of one concept collection can become search terms instead of always using its oldest member',async t=>{
  const store=new ObservationStore(box(t)),engine=new ConceptEngine(store)
  for(const name of ['康德','佛教']) {
    const m=await engine.call('concept_propose',{key:name,source:{id:name,actor:'fish',type:'conversation',excerpt:name},subject:'fish',content:name,tags:['topic'],interpretation:'explicit'})
    await engine.call('concept_review',{key:name,candidate_id:m.id,status:'accepted',reason:'同组不同成员',collections:[{name:'哲学'}]})
  }
  const terms=new Set(),state=store.state().concepts
  for(let i=0;i<30&&terms.size<2;i++)for(const term of interestPlan(state,'members-'+i,store.now()).keywords)terms.add(term)
  assert.deepEqual([...terms].sort(),['佛教','康德'].sort())
})

test('bounded shortlists do not permanently exclude equally scored candidates after the first twenty IDs',async t=>{
  const {store}=await fixture(t),initial=structuredClone(store.state().concepts)
  const candidates=Array.from({length:45},(_,i)=>video(i+1,'猫 '+(i+1)))
  let late=false
  for(let i=0;i<20&&!late;i++) {
    await store.transaction({},d=>{d.state.concepts=structuredClone(initial)})
    const r=await new FeedConcepts({config:cfg('active'),store,runId:'wide-'+i,seed:'wide-'+i}).select({candidates,legacy:candidates,n:1,per:2})
    late=Number(r.selected[0].bv.slice(2))>20
  }
  assert.equal(late,true)
})

test('fatigue is applied between slate slots; uniqueness and per-collection diversity limits remain enforced',async t=>{
  const {store}=await fixture(t),candidates=[video(1,'猫 A'),video(2,'猫 B'),video(3,'康德 A'),video(4,'康德 B')]
  const result=await new FeedConcepts({config:cfg('active'),store,runId:'slate',seed:'a'}).select({candidates:[...candidates,candidates[0]],legacy:candidates,n:4,per:1})
  assert.equal(result.selected.length,2)
  assert.equal(new Set(result.selected.map(v=>v.bv)).size,2)
  assert.ok(result.selected.some(v=>v.t.includes('猫')));assert.ok(result.selected.some(v=>v.t.includes('康德')))
  for(const d of result.decisions)assert.equal(d.fatigue_changes[0].after,0.2)
})

test('bounded seeded perturbation changes close actual choices, remains reproducible, and cannot defeat a clear lead',async t=>{
  const {store}=await fixture(t),original=structuredClone(store.state().concepts)
  const candidates=[video(1,'猫'),video(2,'康德')],winners=new Set()
  for(let i=0;i<20&&winners.size<2;i++) {
    await store.transaction({},d=>{d.state.concepts=structuredClone(original)})
    const r=await new FeedConcepts({config:cfg('active'),store,runId:'noise-'+i,seed:'noise-'+i}).select({candidates,legacy:candidates,n:1,per:2})
    winners.add(r.selected[0].bv)
    const replay=new ConceptEngine(store).replay(r.decisions[0].preview_id)
    assert.equal(replay.matches,true)
    assert.ok(replay.result.rows.every(row=>Math.abs(row.noise)<=0.05))
  }
  assert.equal(winners.size,2)
  const clear=structuredClone(original)
  for(const c of Object.values(clear.collections))c.reward=c.name==='猫'?0.5:-0.5
  for(let i=0;i<8;i++)assert.equal(interestPlan(clear,'clear-'+i,store.now()).competition.winner,Object.values(clear.collections).find(c=>c.name==='猫').id)
})

test('same run retry returns the exact receipt without extra fatigue; different evidence with same run is rejected',async t=>{
  const {store}=await fixture(t),selector=new FeedConcepts({config:cfg('active'),store,runId:'stable',seed:'fixed'}),candidates=[video(1,'猫'),video(2,'康德')]
  const args={candidates,legacy:candidates,n:2,per:2}
  const a=await selector.select(args),before=hash(store.state())
  assert.deepEqual(await selector.select(args),a);assert.equal(hash(store.state()),before)
  await assert.rejects(selector.select({...args,n:1}),/different input/)
  assert.equal(hash(store.state()),before)
})

test('an interrupted slate rolls back every decision and fatigue update, then can retry',async t=>{
  const {store}=await fixture(t),selector=new FeedConcepts({config:cfg('active'),store,runId:'rollback'}),candidates=[video(1,'猫'),video(2,'康德')]
  const before=hash(store.state()),original=store.object.bind(store)
  store.object=x=>{if(x?.decisions&&Object.keys(x.decisions).length)throw Error('simulated snapshot disk failure');return original(x)}
  await assert.rejects(selector.select({candidates,legacy:candidates,n:2,per:2}),/disk failure/)
  assert.equal(hash(store.state()),before);assert.equal(store.events({type:'decision.committed'}).length,0)
  store.object=original
  const r=await selector.select({candidates,legacy:candidates,n:2,per:2})
  assert.equal(r.decisions.length,2)
})

test('shadow preserves legacy keywords and output, logs replayable previews, and does not change learning state',async t=>{
  const {store,engine}=await fixture(t),selector=new FeedConcepts({config:cfg('shadow'),store,runId:'shadow'})
  const before=hash(store.state()),legacy=video(1,'AI'),cat=video(2,'猫')
  assert.deepEqual((await selector.plan(['AI'])).keywords,['AI'])
  const r=await selector.select({candidates:[legacy,cat],legacy:[legacy,cat],n:1,per:2})
  assert.equal(r.selected[0].bv,legacy.bv);assert.equal(r.proposed[0].bv,cat.bv)
  assert.equal(hash(store.state()),before)
  assert.equal(store.events({type:'decision.committed'}).length,0)
  assert.equal(engine.replay(r.decisions[0].preview_id).matches,true)
})

test('disabled leaves the database absent; no usable fish topics or no title match falls back honestly',async t=>{
  const root=path.join(box(t),'unused'),store=new ObservationStore(root),v=video(1,'AI')
  const disabled=new FeedConcepts({config:{conceptSystem:{observe:false}},store})
  assert.deepEqual((await disabled.select({candidates:[v],legacy:[v],n:1,per:2})).selected,[v]);assert.equal(fs.existsSync(root),false)
  const active=new FeedConcepts({config:cfg('active'),store,runId:'empty'})
  const empty=await active.select({candidates:[v],legacy:[v],n:1,per:2})
  assert.equal(empty.fallback,'no_eligible_fish_topics');assert.equal(empty.decisions.length,0)
  await topic(new ConceptEngine(store),'猫',{exclusions:['广告']})
  const excluded=video(2,'猫广告')
  const miss=await new FeedConcepts({config:cfg('active'),store,runId:'miss'}).select({candidates:[excluded],legacy:[excluded],n:1,per:2})
  assert.equal(miss.fallback,'no_title_matches');assert.equal(miss.decisions.length,0)
  assert.equal(feedGroups(store.state().concepts).length,1)
})

test('real feed CLI uses concept search and ranking while preserving all existing exclusion gates; no writes to platform',async t=>{
  const home=box(t),dsh=path.join(home,'profile'),privateDir=path.join(home,'.bili-ai'),conceptDir=path.join(home,'concepts')
  fs.mkdirSync(dsh);fs.mkdirSync(privateDir)
  fs.writeFileSync(path.join(privateDir,'credentials.json'),JSON.stringify({sessdata:'fixture',bili_jct:'fixture',buvid3:'fixture'}))
  fs.writeFileSync(path.join(dsh,'bili-whale.config.json'),JSON.stringify({...cfg('active'),preferences:{like:['AI'],dislike:['带货']},self:{name:'SELF'},risk:{minGapMs:0}}))
  fs.writeFileSync(path.join(dsh,'whale-diary.md'),'看过 BV0000000003')
  fs.writeFileSync(path.join(privateDir,'favorites.json'),JSON.stringify({items:[{bv:'BV0000000004'}]}))
  fs.writeFileSync(path.join(privateDir,'feedback.json'),JSON.stringify({events:[{bv:'BV0000000005'}]}))
  fs.writeFileSync(path.join(privateDir,'quota.json'),JSON.stringify({log:[{type:'comment',target:'BV:BV0000000006'}]}))
  const pool=[...Array.from({length:8},(_,i)=>({bvid:video(i+1,'').bv,title:'猫 '+(i+1),duration:'05:00',danmaku:30,play:1000,author:i===1?'SELF':'UP'})),{bvid:'BV0000000009',title:'猫 碎屑',duration:'00:05',danmaku:0,play:1},{bvid:'BV0000000010',title:'猫 带货',duration:'05:00',danmaku:1000,play:10000}]
  const poolFile=path.join(home,'pool.json'),requests=path.join(home,'requests.jsonl')
  fs.writeFileSync(poolFile,JSON.stringify(pool))
  const store=new ObservationStore(conceptDir);await topic(new ConceptEngine(store),'猫')
  const reads=new VideoReads(store),attempt=await reads.start('BV0000000001')
  const receipt=await reads.complete(attempt.id,{bvid:'BV0000000001',cid:'123',duration:300,subtitles:[{from:0,to:4,content:'猫的生活'}]})
  await reads.acceptOutput(receipt.marker,{session_id:'fish',route:{provider:'fixture',model:'fixture'}})
  const env={...process.env,HOME:home,USERPROFILE:home,DSH_HOME:dsh,BILI_WHALE_CONFIG:path.join(dsh,'bili-whale.config.json'),BILI_CONCEPT_HOME:conceptDir,TEST_FEED_POOL:poolFile,TEST_REQUESTS:requests,NODE_OPTIONS:'--import='+pathToFileURL(fileURLToPath(new URL('./helpers/feed-fetch.mjs',import.meta.url))).href}
  const run=()=>spawnSync(process.execPath,[fileURLToPath(new URL('../tools/commands/feed.mjs',import.meta.url)),'--source','search','--n','2','--json','--run-id','cli','--seed','fixed'],{env,encoding:'utf8',timeout:15000})
  const r=run();assert.ifError(r.error);assert.equal(r.status,0,r.stderr)
  const result=JSON.parse(r.stdout)
  assert.ok(result.search.keywords.includes('猫'))
  assert.equal(result.selected.length,2)
  for(const x of result.selected)assert.ok(['BV0000000007','BV0000000008'].includes(x.bv),JSON.stringify(x))
  assert.ok(fs.readFileSync(requests,'utf8').includes('keyword=%E7%8C%AB'))
  assert.ok(fs.readFileSync(requests,'utf8').split('\n').filter(Boolean).every(l=>JSON.parse(l).method==='GET'))
  const before=hash(store.state()),requestsBefore=fs.readFileSync(requests,'utf8')
  fs.unlinkSync(poolFile);fs.unlinkSync(path.join(privateDir,'credentials.json'))
  const retry=run();assert.equal(retry.status,0,retry.stderr);assert.deepEqual(JSON.parse(retry.stdout),result);assert.equal(hash(store.state()),before)
  assert.equal(fs.readFileSync(requests,'utf8'),requestsBefore)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ObservationStore, hash } from '../tools/lib/concept-system/store.mjs'
import { ConceptEngine } from '../tools/lib/concept-system/engine.mjs'
import { learningCatalog } from '../tools/lib/concept-system/catalog.mjs'
import { LearningQueue, LearningWorker, validateEvaluation } from '../tools/lib/concept-system/learning.mjs'
import { evaluateWithHost } from '../lib/learning-host.js'
import { conceptMaintenanceSkill } from '../lib/concept-skill.js'

const metadata={definition:'前端图形与可视化实现',boundary:'不收录无图形实现内容的泛前端话题',aliases:['前端可视化'],related:[]}
const source={id:'reading-2',actor:'third_party',type:'video',excerpt:'数据可视化使用 three.js 绘制三维场景。',video:{bvid:'BV1234567890',cid:'1',section:'subtitles',part:1,parts:1,content_hash:'a'.repeat(64)}}
const candidate=collections=>({subject:'fish',content:'数据可视化',tags:['topic'],scene:'general',triggers:[],exclusions:[],interpretation:'mention',quote:'数据可视化',status:'accepted',reason:'字幕话题，不推断喜好',collections})
const fresh=name=>({name,...metadata,aliases:[],reason:'已有目录不能容纳该主题'})
function box(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-catalog-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=new ObservationStore(root);return {store,engine:new ConceptEngine(store)}}
async function seed(engine,{key='seed',subject='fish',name='three_js_visualization'}={}) {
  const m=await engine.call('concept_propose',{key,subject,content:'three.js 图形',tags:['topic'],source:{id:key,actor:'user',type:'conversation',excerpt:'three.js 图形'}})
  const r=await engine.call('concept_review',{key,candidate_id:m.id,status:'accepted',reason:'历史概念',collections:[{name}]})
  return {member:m.id,id:r.collection_ids[0]}
}
test('directory exposes every group independently of member query limits and preserves old data',async t=>{
  const {store,engine}=box(t),a=await seed(engine),b=await seed(engine,{key:'owner',subject:'user'})
  const before=hash(store.state())
  const page=await engine.call('concept_catalog',{limit:1})
  assert.equal(page.total,2);assert.equal(page.items.length,1)
  assert.equal((await engine.call('concept_catalog',{page:2,limit:1})).items.length,1)
  const fish=(await engine.call('concept_catalog',{subject:'fish'})).items[0]
  assert.equal(fish.id,a.id);assert.equal(fish.metadata_status,'needs_definition');assert.equal(fish.definition,null)
  assert.equal(fish.representatives[0].source_id,'seed');assert.notEqual(a.id,b.id)
  assert.equal(hash(store.state()),before)
})
test('documented aliases are searchable, preserve provenance, and cannot collide across groups',async t=>{
  const {store,engine}=box(t),a=await seed(engine),b=await seed(engine,{key:'other',name:'摄影'})
  const oldMember=hash(store.state().concepts.members[a.member])
  await engine.call('concept_catalog_update',{key:'describe',collection_id:a.id,...metadata,source_ids:['seed'],reason:'根据已有图形材料明确边界'})
  const found=await engine.call('concept_catalog',{query:'前端可视化'})
  assert.equal(found.total,1);assert.equal(found.items[0].id,a.id)
  assert.equal(found.items[0].metadata_evidence.reason,'根据已有图形材料明确边界')
  assert.equal(hash(store.state().concepts.members[a.member]),oldMember)
  await assert.rejects(engine.call('concept_catalog_update',{key:'collision',collection_id:b.id,...metadata,source_ids:['other'],reason:'冲突'}),/already belongs/)
  await assert.rejects(engine.call('concept_catalog_update',{key:'foreign-source',collection_id:a.id,...metadata,source_ids:['other'],reason:'错误来源'}),/evidence must belong/)
  assert.equal((await engine.call('concept_catalog',{})).total,2)
  assert.equal(new ConceptEngine(new ObservationStore(store.directory)).store.state().concepts.collections[a.id].definition,metadata.definition)
})
test('normalized names and aliases reuse IDs, with subject boundaries and ambiguity checks',async t=>{
  const {engine,store}=box(t),a=await seed(engine)
  await engine.call('concept_catalog_update',{key:'define',collection_id:a.id,...metadata,source_ids:['seed'],reason:'目录定义'})
  const b=await seed(engine,{key:'new-member',name:'THREE JS VISUALIZATION'})
  const c=await seed(engine,{key:'alias-member',name:'前端可视化'})
  assert.equal(a.id,b.id);assert.equal(a.id,c.id)
  const m=await engine.call('concept_propose',{key:'user',subject:'user',content:'图形',tags:['topic'],source:{id:'user',actor:'user',type:'conversation',excerpt:'图形'}})
  await assert.rejects(engine.call('concept_review',{key:'wrong-subject',candidate_id:m.id,status:'accepted',reason:'错误',collections:[{collection_id:a.id}]}),/subject mismatch/)
  assert.equal(Object.keys(store.state().concepts.collections).length,1)
})
test('normal background learning actually delivers the directory to the model and joins by ID',async t=>{
  const {store,engine}=box(t),a=await seed(engine)
  await engine.call('concept_catalog_update',{key:'define',collection_id:a.id,...metadata,source_ids:['seed'],reason:'目录定义'})
  const oldSource=hash(store.state().concepts.sources.seed)
  let offered
  const ctx={llm:{async prepareCall(){return {config:{},async *stream(options){
    offered=JSON.parse(options.messages[0].content[0].text)
    const existing=offered.catalog.inventory.find(c=>c.name==='three_js_visualization')
    assert.ok(existing);assert.match(options.system,/先对照已有群/)
    assert.ok(options.system.includes(conceptMaintenanceSkill.content))
    assert.ok(offered.catalog.details.find(c=>c.id===existing.id).representatives.length)
    const output={candidates:[candidate([{collection_id:existing.id,reason:'数据可视化属于已有前端图形群，复用而不拆同义群'}])]}
    yield {type:'block-end',index:0,block:{type:'text',text:JSON.stringify(output)}}
    yield {type:'finish',reason:{kind:'stop'}}
  }}}}}
  const w=new LearningWorker({store,evaluate:(job,signal)=>evaluateWithHost(ctx,job,signal)})
  await w.queue.enqueue({session_id:'fish',source,route:{provider:'fixture',model:'fixture'}})
  await w.queue.ready('fish');await w.wake();await w.stop()
  assert.equal(offered.catalog.policy,'catalog-v1')
  assert.equal(Object.keys(store.state().concepts.collections).length,1)
  assert.equal(store.state().concepts.collections[a.id].members.length,2)
  assert.equal(hash(store.state().concepts.sources.seed),oldSource)
  const receipt=store.events({type:'collection.placement_decided'}).at(-1)
  assert.equal(receipt.data.collection_id,a.id);assert.match(receipt.data.reason,/复用/)
  const req=store.events({type:'learning.request'})[0]
  assert.deepEqual(store.getObject(req.data.request.hash).content.catalog,offered.catalog)
  const response=store.getObject(store.events({type:'learning.response'})[0].data.object.hash).content
  assert.deepEqual(response.skill,{name:conceptMaintenanceSkill.name,hash:conceptMaintenanceSkill.hash})
  assert.ok(response.policy.includes(conceptMaintenanceSkill.content))
})
test('new groups require full definitions and routing rejects unknown IDs, cross subjects and synonym names',async t=>{
  const {store,engine}=box(t),a=await seed(engine),catalog=learningCatalog(store.state().concepts,source)
  for(const placement of ['随意名字',{collection_id:'invented',reason:'x'},{...fresh('THREE JS VISUALIZATION')}, {name:'摄影',reason:'x'}])
    assert.throws(()=>validateEvaluation({candidates:[candidate([placement])]},source,catalog))
  const owner=await seed(engine,{key:'owner',subject:'user'})
  assert.throws(()=>validateEvaluation({candidates:[candidate([{collection_id:owner.id,reason:'x'}])]},source,learningCatalog(store.state().concepts,{...source,actor:'user'})),/same subject/)
  const w=new LearningWorker({store,evaluate:async()=>({candidates:[candidate([fresh('三维渲染算法')])]})})
  await w.queue.enqueue({session_id:'fish',source,route:{provider:'fixture',model:'fixture'}});await w.queue.ready('fish');await w.wake();await w.stop()
  const added=(await engine.call('concept_catalog',{query:'三维渲染算法'})).items[0]
  assert.equal(added.definition,metadata.definition);assert.equal(added.metadata_evidence.source_ids[0],source.id)
  assert.equal(store.events({type:'collection.placement_decided'}).at(-1).data.action,'create')
  assert.notEqual(added.id,a.id)
})
test('truncated catalogs disclose coverage and cannot authorize creation',()=>{
  const state={collections:{},members:{}}
  for(let i=0;i<600;i++)state.collections['g'+i]={id:'g'+i,subject:'fish',name:'话题'+i+'x'.repeat(90),aliases:[],members:[]}
  const catalog=learningCatalog(state,source)
  assert.equal(catalog.total,600);assert.equal(catalog.truncated,true)
  assert.ok(Buffer.byteLength(JSON.stringify(catalog))<50000)
  assert.throws(()=>validateEvaluation({candidates:[candidate([fresh('新主题')])]},source,catalog),/Incomplete catalog/)
  assert.doesNotThrow(()=>validateEvaluation({candidates:[candidate([{collection_id:catalog.inventory[0].id,reason:'有明确归属'}])]},source,catalog))
})
test('restart retries preserve the exact offered catalog even if other groups have since changed',async t=>{
  const {store,engine}=box(t),a=await seed(engine)
  let now=1000000,firstCatalog
  store.now=()=>now
  const w=new LearningWorker({store,evaluate:async job=>{firstCatalog=job.catalog;throw Error('transient')}})
  await w.queue.enqueue({session_id:'fish',source,route:{provider:'fixture',model:'fixture'}});await w.queue.ready('fish');await w.wake();await w.stop()
  await seed(engine,{key:'concurrent',name:'摄影'})
  now+=30001
  const resumed=new LearningWorker({store,evaluate:async job=>{
    assert.deepEqual(job.catalog,firstCatalog);assert.equal(job.error,'transient')
    return {candidates:[candidate([{collection_id:a.id,reason:'复用原目录中的图形群'}])]}
  }})
  await resumed.wake();await resumed.stop()
  assert.equal(store.events({type:'learning.catalog_prepared'}).length,1)
  assert.equal(store.events({type:'learning.completed'}).length,1)
})
test('old validated string-name jobs still replay without re-inference or lost provenance',async t=>{
  const {store}=box(t),q=new LearningQueue(store)
  let now=1000000;store.now=()=>now
  await q.enqueue({session_id:'fish',source,route:{provider:'fixture',model:'fixture'}});await q.ready('fish')
  const leased=await q.claim()
  await q.update(leased,{evaluation:validateEvaluation({candidates:[candidate(['历史群名'])]},source)},'learning.validated')
  now+=90001
  const w=new LearningWorker({store,evaluate:()=>assert.fail('must reuse historical evaluation')})
  await w.wake();await w.stop()
  assert.equal(store.events({type:'learning.completed'}).length,1)
  assert.equal(Object.values(store.state().concepts.collections)[0].name,'历史群名')
  assert.equal(Object.values(store.state().concepts.sources)[0].id,source.id)
})

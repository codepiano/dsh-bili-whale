import test from 'node:test'
import assert from 'node:assert/strict'
import {interestPlan,feedGroups} from '../tools/lib/concept-system/feed.mjs'
import {explorationPlan} from '../tools/lib/concept-system/exploration.mjs'
import {readingFatigue,readingPenalty,readingDomains,interestEligibility} from '../tools/lib/concept-system/breadth.mjs'
import {compactFeed} from '../tools/lib/concept-system/feed-presentation.mjs'
const now=1793700000000
function fixture(){
 const s={schema:1,feedback:{},sources:{},members:{},collections:{},decisions:{},parameters:{algorithm:'concept-v1',fatigueHalfLifeMs:21600000,fatigueStep:.2,fishReward:.05,maxReward:.5,noise:.05,tieBand:.1,userReward:.1},exploration:{config:{algorithm:'exploration-v1',history_window:40,ratios:{deep:.6,revisit:.25,discover:.15}},questions:{}}}
 for(const [id,name,domain] of [['code','Godot','软件与工程'],['test','TDD','软件与工程'],['history','法国革命','历史与社会'],['philosophy','生活形式','哲学与认知'],['ops','字幕为空','方法']]){
  s.sources[id]={id,actor:id==='ops'?'fish':'third_party',type:'video',ref:id,excerpt:name}
  s.members[id]={id,content:name,tags:['topic'],scene:'watch',subject:'fish',interpretation:'mention',status:'accepted',source_id:id,keywords:[name]}
  s.collections[id]={id,name:id==='ops'?'检索策略经验':name,domain,subject:'fish',members:[id],reward:id==='ops'?2:0,fatigue:{},related:[]}
  s.exploration.questions[id]={id,collection_id:id,subject:'fish',scene:'watch',status:'active',created_at:now-1000,updated_at:id==='code'?now:now-1000,question:name}
 }
 return s
}
const read=(s,id,group,path='deep',ago=100)=>{s.decisions[id]={id,subject:'fish',scene:'watch',at:now-ago,collection_ids:[group],exploration:{path,target:{collection_id:group,question_id:group},exposure:{at:now-ago,read_id:id,source_ids:[group]},progress:{outcome:'completed'}}}}
test('operations cannot occupy interests or exploration targets; explicit scientific objects stay eligible',()=>{
 const s=fixture(),before=JSON.stringify(s);const p=interestPlan(s,'normal',now)
 assert.ok(!p.keywords.includes('字幕为空'));assert.ok(p.excluded.some(x=>x.member_id==='ops'));assert.equal(feedGroups(s).length,4)
 for(const ratios of [{deep:1,revisit:0,discover:0},{deep:0,revisit:1,discover:0}]){s.exploration.config.ratios=ratios;const p=explorationPlan(s,{subject:'fish',scene:'watch',seed:'auto',limit:50},now);assert.ok(!p.questions.some(q=>q.id==='ops'));assert.ok(!p.revisit.some(g=>g.collection_id==='ops'))}
 assert.equal(new Set(p.keyword_sources.map(x=>x.domain)).size,3)
 assert.equal(interestEligibility({...s.members.ops,content:'可证伪性',interest_role:'content'},s,s.collections.ops).eligible,true)
 assert.equal(interestEligibility({...s.members.code,interest_role:'method'},s,s.collections.code).eligible,false)
 assert.equal(JSON.parse(before).members.ops.content,s.members.ops.content)
})
test('watch fatigue is visible to feed, while actual reading also penalizes sibling collections in the same domain',()=>{
 const s=fixture();s.collections.code.fatigue.watch={value:.8,at:now};
 assert.equal(readingFatigue(s.collections.code,'feed',now,s.parameters),.8)
 assert.equal(readingFatigue(s.collections.code,'reply',now,s.parameters),0)
 assert.equal(readingPenalty(s,s.collections.test,now).factor,1)
 s.decisions.selected={id:'selected',subject:'fish',scene:'watch',exploration:{target:{collection_id:'code'}}}
 assert.equal(readingPenalty(s,s.collections.test,now).factor,1)
 read(s,'actual','code');assert.ok(readingPenalty(s,s.collections.test,now).factor<.51)
 assert.equal(readingPenalty(s,s.collections.philosophy,now).factor,1)
 s.decisions.actual.exploration.progress.outcome='failed';assert.equal(readingPenalty(s,s.collections.test,now).factor,1)
})
test('deep rotates away from freshly updated read questions; revisit crosses domains, and discovery carries the underread domain into the actual compact prompt',()=>{
 const s=fixture();read(s,'r','code');s.exploration.config.ratios={deep:1,revisit:0,discover:0}
 const args={subject:'fish',scene:'watch',seed:'unchanged',limit:50};let p=explorationPlan(s,args,now)
 assert.notEqual(p.questions[0].domain,'软件与工程');assert.equal(p.questions.at(-1).id,'code')
 s.exploration.config.ratios={deep:0,revisit:1,discover:0};p=explorationPlan(s,args,now);assert.notEqual(p.revisit[0].domain,'软件与工程')
 s.exploration.config.ratios={deep:0,revisit:0,discover:1};p=explorationPlan(s,args,now);assert.notEqual(p.discovery.target_domain,'软件与工程')
 const compact=compactFeed({status:'search_plan_required',run_id:'normal',exploration:p,interests:interestPlan(s,'normal',now)})
 assert.equal(compact.exploration.discovery.target_domain,p.discovery.target_domain);assert.ok(compact.exploration.breadth.domains.length);assert.equal(compact.interests.excluded_method_count,1)
 assert.deepEqual(explorationPlan(s,args,now),p)
})
test('domain metadata overrides legacy hints and discovery coverage can follow sourced member placement',()=>{
 const s=fixture();s.decisions.new={id:'new',subject:'fish',exploration:{path:'discover',domain:'未分类',target:{candidate_id:'history'},exposure:{at:now},progress:{outcome:'completed'}}}
 assert.deepEqual(readingDomains(s,s.decisions.new),['历史与社会'])
 s.collections.history.domain='政治史';assert.deepEqual(readingDomains(s,s.decisions.new),['政治史'])
})

test('normal video body delivery changes future interest penalties only after all real pages reach the model, exactly once',async t=>{
 const {default:fs}=await import('node:fs'),{default:os}=await import('node:os'),{default:path}=await import('node:path')
 const {ObservationStore}=await import('../tools/lib/concept-system/store.mjs'),{VideoReads}=await import('../tools/lib/concept-system/video-reads.mjs')
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-breadth-receipt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const store=new ObservationStore(root,{now:()=>now}),s=fixture(),bvid='BV1234567890'
 s.decisions.d={id:'d',subject:'fish',scene:'watch',selected:bvid,collection_ids:['code'],exploration:{path:'deep',target:{collection_id:'code',question_id:'code'}}}
 await store.transaction({},d=>{d.state.concepts=s})
 await store.transaction({key:'feed-select:ordinary',input:{}},()=>({mode:'active',selected:[{bv:bvid}],decisions:[{id:'d',selected:bvid}]}))
 const reads=new VideoReads(store),r=await reads.start(bvid,{feed_run_id:'ordinary'}),receipt=await reads.complete(r.id,{bvid,cid:'1',title:'Godot',subtitles:[{from:0,to:10,content:'真实正文说明架构维护及版本升级。'}]})
 await reads.acceptOutput(receipt.marker,{session_id:'fish',route:{provider:'deepseek-account'},learn:false})
 assert.equal(readingPenalty(store.state().concepts,s.collections.test,now).factor,1)
 const page=await reads.page({read_id:r.id,page:1});await reads.acceptPage(page,{session_id:'fish',host_seq:10,learn:false})
 assert.equal(readingPenalty(store.state().concepts,s.collections.test,now).factor,1)
 await reads.acceptDelivery({session_id:'fish',through_seq:10,host_seq:11})
 assert.equal(store.events({type:'exploration.exposed'}).length,1)
 const state=store.state().concepts;assert.equal(state.decisions.d.exploration.domain,'软件与工程')
 assert.ok(readingPenalty(state,state.collections.test,now).factor<1)
 const actual=interestPlan(state,'normal',now);assert.equal(actual.competition.rows.find(r=>r.label==='test').reading_penalty.reads,1)
 await reads.acceptDelivery({session_id:'fish',through_seq:10,host_seq:12})
 assert.equal(readingPenalty(store.state().concepts,s.collections.test,now).reads,1)
 const {ConceptEngine}=await import('../tools/lib/concept-system/engine.mjs');const engine=new ConceptEngine(store),complete=store.journal.use(db=>JSON.parse(db.prepare('select payload from video_reads where id=?').get(r.id).payload))
 await engine.call('reading_domain_assess',{key:'video-body-domain',read_id:r.id,domain:'软件与工程',reason:'真实字幕正文讨论架构维护',evidence:[{source_id:complete.sources[0].id,quote:'真实正文说明架构维护及版本升级'}]})
 const saved=store.journal.use(db=>JSON.parse(db.prepare('select payload from video_reads where id=?').get(r.id).payload));assert.equal(saved.domain_assessment.domain,'软件与工程');assert.equal(store.events({type:'exploration.exposed'}).length,1)
})

test('method classification and sourced domain changes survive restart with original sources and versioned rationale',async t=>{
 const {default:fs}=await import('node:fs'),{default:os}=await import('node:os'),{default:path}=await import('node:path')
 const {ObservationStore}=await import('../tools/lib/concept-system/store.mjs'),{ConceptEngine}=await import('../tools/lib/concept-system/engine.mjs')
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-breadth-catalog-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const store=new ObservationStore(root),engine=new ConceptEngine(store)
 const m=await engine.call('concept_propose',{key:'m',subject:'fish',content:'检索复盘',interest_role:'method',tags:['topic'],source:{id:'real',actor:'fish',type:'conversation',excerpt:'本轮检索只命中同名词，需要核对。'}})
 const placed=await engine.call('concept_review',{key:'review',candidate_id:m.id,status:'accepted',reason:'保留方法经验',collections:[{name:'检索经验',domain:'方法'}]})
 const cid=placed.collection_ids[0]
 await engine.call('concept_catalog_update',{key:'domain',collection_id:cid,definition:'检索过程的操作经验',boundary:'不作为内容兴趣',domain:'探索方法',source_ids:['real'],reason:'区分操作方法和内容主题'})
 await engine.call('concept_enrich',{key:'role',candidate_id:m.id,interest_role:'method',keywords:['检索'],evidence:[{source_id:'real',quote:'本轮检索只命中同名词'}],reason:'该条是本轮操作方法，不是内容兴趣'})
 const fresh=new ConceptEngine(new ObservationStore(root));assert.equal(fresh.store.state().concepts.members[m.id].interest_role,'method')
 assert.equal(fresh.store.state().concepts.members[m.id].source_id,'real');assert.equal(feedGroups(fresh.store.state().concepts).length,0)
 const catalog=await fresh.call('concept_catalog',{});assert.equal(catalog.items[0].domain.name,'探索方法');assert.equal(catalog.items[0].domain.origin,'catalog')
 const e=store.events({type:'collection.catalog_updated'}).at(-1);assert.equal(e.data.previous_domain,'方法');assert.equal(e.data.domain,'探索方法');assert.equal(e.data.metadata_evidence.reason,'区分操作方法和内容主题')
})

 test('revisit excludes expression/principle-only groups when content exists; free domain labels cannot mutate prototypes',()=>{
 const s=fixture();s.members.expression={...s.members.code,id:'expression',tags:['word']};s.collections.expression={...s.collections.code,id:'expression',name:'技术口语',members:['expression'],domain:'__proto__'};
 s.exploration.config.ratios={deep:0,revisit:1,discover:0};const p=explorationPlan(s,{subject:'fish',scene:'watch',seed:'ordinary',limit:50},now);assert.ok(!p.revisit.some(g=>g.collection_id==='expression'));
 s.collections.history.domain='__proto__';const interests=interestPlan(s,'ordinary',now);assert.ok(interests.breadth.domains.some(d=>d.domain==='__proto__'));assert.equal(Object.prototype.count,undefined);
 })

test('after two actual same-domain reads every unchanged seed routes to an available underread domain, without changing ratios',()=>{
 const s=fixture();delete s.exploration.questions.history;delete s.exploration.questions.philosophy
 read(s,'r0','code','deep',200);read(s,'r1','test','deep',100)
 const ratios=structuredClone(s.exploration.config.ratios)
 for(let i=0;i<32;i++){
  const p=explorationPlan(s,{subject:'fish',scene:'watch',seed:'normal-'+i,limit:50},now)
  assert.notEqual(p.selected_domain,'软件与工程');assert.equal(p.breadth_guard.previous_domain,'软件与工程');assert.equal(p.breadth_guard.consecutive_reads,2)
  assert.equal(p.breadth_guard.required_domain,p.selected_domain);assert.ok(['revisit','discover'].includes(p.path));assert.deepEqual(p.config.ratios,ratios)
  assert.deepEqual(explorationPlan(s,{subject:'fish',scene:'watch',seed:'normal-'+i,limit:50},now),p)
 }
})
test('domain guard honors disabled paths, excludes failed/skipped reads, preserves cold start and has auditable configuration',()=>{
 const s=fixture();delete s.exploration.questions.history;delete s.exploration.questions.philosophy
 read(s,'r0','code','deep',200);read(s,'r1','code','deep',100)
 s.exploration.config.ratios={deep:1,revisit:0,discover:0}
 let p=explorationPlan(s,{subject:'fish',scene:'watch',seed:'normal',limit:50},now);assert.equal(p.path,'deep');assert.equal(p.breadth_guard.required_domain,null)
 s.exploration.config.ratios={deep:.6,revisit:.25,discover:.15};s.decisions.r1.exploration.progress.outcome='failed'
 p=explorationPlan(s,{subject:'fish',scene:'watch',seed:'normal',limit:50},now);assert.equal(p.breadth_guard.consecutive_reads,1)
 s.decisions.r0.exploration.progress.outcome='skipped';p=explorationPlan(s,{subject:'fish',scene:'watch',seed:'normal',limit:50},now);assert.equal(p.breadth_guard.consecutive_reads,0)
 s.exploration.config.breadth={enabled:false,max_consecutive_domain_reads:1,max_readings_per_target:1};p=explorationPlan(s,{subject:'fish',scene:'watch',seed:'normal',limit:50},now);assert.equal(p.reading_limit,null);assert.equal(p.breadth_guard.required_domain,null)
})
test('a one-reading remainder cannot overshoot the domain streak; compact normal packets retain the domain constraint',()=>{
 const s=fixture();delete s.exploration.questions.history;delete s.exploration.questions.philosophy
 read(s,'r0','code','deep',100)
 for(let i=0;i<16;i++){
  const p=explorationPlan(s,{subject:'fish',scene:'watch',seed:'sequence-'+i,limit:50},now)
  if(p.selected_domain==='软件与工程')assert.equal(p.reading_limit,1)
  const out=compactFeed({status:'search_plan_required',run_id:'normal',exploration:p})
  assert.deepEqual(out.exploration.breadth_guard,p.breadth_guard);assert.equal(out.exploration.reading_limit,p.reading_limit)
 }
})

 test('configured one-read domain limit cannot preselect two readings in a new domain',()=>{
 const s=fixture();delete s.exploration.questions.history;delete s.exploration.questions.philosophy;read(s,'only','code');s.exploration.config.breadth={enabled:true,max_consecutive_domain_reads:1,max_readings_per_target:3};
 const p=explorationPlan(s,{subject:'fish',scene:'watch',seed:'unchanged',limit:50},now);assert.notEqual(p.selected_domain,'软件与工程');assert.equal(p.reading_limit,1);
 })

 test('domain budget searches other targets within an enabled path instead of mistaking its unknown first group for no alternative',()=>{
 const s=fixture();read(s,'r0','code','deep',200);read(s,'r1','code','deep',100);s.members.aaa={...s.members.history,id:'aaa',source_id:'aaa'};s.sources.aaa={...s.sources.history,id:'aaa',ref:'aaa'};s.collections.aaa={...s.collections.history,id:'aaa',members:['aaa'],domain:'未分类'};s.exploration.config.ratios={deep:0,revisit:1,discover:0};
 const p=explorationPlan(s,{subject:'fish',scene:'watch',seed:'normal',limit:50},now);assert.equal(p.path,'revisit');assert.equal(p.breadth_guard.required_domain,p.revisit[0].domain);assert.notEqual(p.revisit[0].domain,'未分类');assert.notEqual(p.revisit[0].domain,'软件与工程');
 })

test('legacy discovery domain can follow actual read/source evidence on a different accepted representative, not just the search ID',()=>{
 const s=fixture();s.members.pending={...s.members.code,id:'pending',status:'pending'}
 s.decisions.actual={id:'actual',subject:'fish',exploration:{path:'discover',domain:'未分类',target:{candidate_id:'pending'},exposure:{read_id:'actual-read',source_ids:['actual-page'],at:now},progress:{outcome:'completed'}}}
 assert.deepEqual(readingDomains(s,s.decisions.actual),[])
 s.members.history.evidence=[{read_id:'actual-read',source_id:'actual-page',quote:'历史正文中有依据的代表词'}]
 assert.deepEqual(readingDomains(s,s.decisions.actual),['历史与社会']);assert.equal(s.members.pending.status,'pending')
 s.decisions.actual.exploration.domain_assessment={read_id:'actual-read',domain:'哲学与认知'};assert.deepEqual(readingDomains(s,s.decisions.actual),['哲学与认知'],'explicit body assessment is authoritative and independent of later placement')
})

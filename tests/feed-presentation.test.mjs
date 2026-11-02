import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {compactFeed} from '../tools/lib/concept-system/feed-presentation.mjs';
import {ObservationStore, hash} from '../tools/lib/concept-system/store.mjs';
import {ConceptEngine} from '../tools/lib/concept-system/engine.mjs';

const question = {id:'q1', question:'如何核验维护成本？', remaining:'缺少工时', next_step:'找真实项目', source_ids:['s1'], answered:'之前读过的长篇总结'.repeat(100)};
function packet() {
  const row = {label:'topic', reason:'实际依据'.repeat(100), score:1};
  return {status:'search_plan_required', run_id:'old-run', seed:'old-seed', state_version:'same',
    interests:{keywords:['维护成本'], keyword_sources:[{term:'维护成本',member_id:'m1',collection_id:'g1'}], competition:{winner:'topic',rows:Array.from({length:30},(_,i)=>({...row,label:'topic'+i}))}, member_competitions:[{winner:'topic',rows:[row]}]},
    exploration:{path:'deep', target:{collection_id:'g1',question_id:'q1'}, questions:[question], revisit:Array.from({length:100},(_,i)=>({collection_id:'g'+i,reason:'回访理由'.repeat(200)}))},
    target:{collection_id:'g1',question_id:'q1',name:'工程证据',question,members:Array.from({length:8},(_,i)=>({id:'m'+i,content:'已有成员内容'.repeat(100),tags:['topic'],keywords:['维护']}))},
    stances:[{member_id:'belief',content:'需要核验'}], instructions:'根据未解问题提出查询词'};
}
test('compact plans omit unselected history and duplicate scores, preserve task and stable detail pointers', () => {
  const full=packet(), before=structuredClone(full), result=compactFeed(full);
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 65536);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 6000);
  assert.deepEqual(result.interests.keywords,full.interests.keywords);
  assert.equal(result.exploration.question.remaining,question.remaining);
  assert.equal(result.exploration.questions,undefined);
  assert.equal(result.interests.competition,undefined);
  assert.equal(result.exploration.question.answered,undefined);
  assert.equal(result.target.members.length,3);
  assert.equal(result.target.member_count,8);
  assert.equal(result.target.members[0].content_truncated,true);
  assert.deepEqual(result.stances,full.stances);
  assert.deepEqual(compactFeed(result),result,'CLI and orchestrator projection must be idempotent');
  assert.deepEqual(full,before,'audit packet is never mutated');
});
test('details page archived evidence through engine without modifying state or creating events', async t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-details-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const store=new ObservationStore(home),engine=new ConceptEngine(store),full=packet();
  const object=store.object(full);
  await store.transaction({},d=>{d.state.feed_searches={'old-run':{packet:object.hash}};d.state.feed_judgments={'old-run':{packet:store.object({...full,status:'judgment_required',candidates:[{bv:'BV0000000001',description:'完整简介'}]}).hash}}});
  const before=hash(store.read());
  const call=(section,args={})=>engine.call('feed_details',{run_id:'old-run',section,...args});
  const first=await call('interest_competition',{limit:10});
  assert.equal(first.total,30);assert.equal(first.items.length,10);assert.equal(first.next_offset,10);
  const second=await engine.call(first.continue_with.tool,first.continue_with.arguments);
  assert.deepEqual(second.items,full.interests.competition.rows.slice(10,20));
  assert.deepEqual((await call('questions')).items,[question]);
  assert.equal((await call('target_members')).items[0].content,full.target.members[0].content);
  assert.equal((await call('revisit',{offset:99})).next_offset,null);
  assert.equal((await call('member_competitions')).competition_count,1);
  assert.equal((await call('candidates',{stage:'judgment'})).items[0].description,'完整简介');
  await assert.rejects(call('questions',{run_id:'missing'}),/No archived/);
  await assert.rejects(call('questions',{limit:100}),/10/);
  await assert.rejects(call('member_competitions',{competition_index:4}),/out of range/);
  assert.equal(hash(store.read()),before,'queries must not alter receipts, fatigue or events');
});
test('judgment projection preserves relevance policy, all stances and complete candidate material', () => {
  const full={...packet(),status:'judgment_required',selection_policy:{min_relevance:0.5},candidates:[{bv:'BV0000000001',t:'标题',description:'完整简介'.repeat(1000)}]};
  const result=compactFeed(full);
  assert.deepEqual(result.candidates,full.candidates);
  assert.deepEqual(result.selection_policy,full.selection_policy);
  assert.deepEqual(result.stances,full.stances);
  assert.equal(result.details.arguments.stage,'judgment');
});
test('completed search and selection responses omit duplicate audit payloads but keep receipt IDs', () => {
  const full=packet();
  const ready=compactFeed({status:'search_ready',run_id:full.run_id,keywords:['维护成本'],exploration:full.exploration});
  assert.equal(ready.exploration.questions,undefined);
  const selected=compactFeed({status:'selected',selected:[{bv:'BV0000000001'}],decisions:[{id:'d1',preview_id:'p1',input:{options:full},exploration:full.exploration}],trace_id:'feed-trace'});
  assert.deepEqual(selected.decisions,[{id:'d1',preview_id:'p1'}]);
  assert.equal(selected.details.tool,'trace_get');
});
test('JSON output flushes a large multilingual payload before explicit exit under a real slow pipe', async () => {
  const module=pathToFileURL(fileURLToPath(new URL('../tools/lib/json-output.mjs',import.meta.url))).href;
  const text='完整输出🐟'.repeat(100000);
  const child=spawn(process.execPath,['--input-type=module','-e',`import {writeJson} from ${JSON.stringify(module)};await writeJson({text:'完整输出🐟'.repeat(100000)});process.exit(0)`],{stdio:['ignore','pipe','pipe']});
  const chunks=[];let errors='';child.stderr.on('data',c=>errors+=c);
  child.stdout.pause();
  const exited=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(errors)))});
  await new Promise(resolve=>setTimeout(resolve,50));
  child.stdout.on('data',c=>chunks.push(c));child.stdout.resume();
  await exited;
  assert.equal(JSON.parse(Buffer.concat(chunks).toString('utf8')).text,text);
});

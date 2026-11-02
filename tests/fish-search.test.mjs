import test from 'node:test'
import assert from 'node:assert/strict'
import {registerFishSearch} from '../lib/fish-search.js'
function fixture(provider) {
  let tool
  registerFishSearch({tools:{register:t=>{tool=t;return ()=>{}}},web:{searchProviders:new Map([['deepseek-search-api',provider]])},acceptSession:id=>id==='fish'})
  return {tool,exec:{agent:{session:{id:'fish'}},signal:new AbortController().signal}}
}
test('fish search uses only the independent API, interleaves queries and bounds native context',async()=>{
  const calls=[],provider={available:()=>true,search:async(args,signal)=>{calls.push(args);assert.ok(signal);return {sources:Array.from({length:8},(_,i)=>({url:`https://example.org/${args.query}/${i}`,title:'标题',snippet:'摘要'.repeat(1000)})),truncated:false}}}
  const {tool,exec}=fixture(provider),result=await tool.execute({queries:['历史','物理']},exec)
  assert.equal(result.provider,'deepseek-search-api');assert.equal(result.successful_requests,2);assert.equal(result.sources.length,8);assert.equal(result.truncated,true)
  assert.deepEqual(calls.map(c=>c.maxResults),[8,8]);assert.ok(result.sources[0].url.includes('历史'));assert.ok(result.sources[1].url.includes('物理'))
  assert.equal(result.sources[0].snippet.length,1000);assert.ok(Buffer.byteLength(tool.output.render({},result)[0].text)<40000)
})
test('fish search rejects other sessions and invalid queries before any API use; failures never fall back to a model',async()=>{
  let calls=0
  const {tool,exec}=fixture({available:()=>true,search:async()=>{calls++;throw Error('failed')}})
  await assert.rejects(tool.execute({queries:['词']},{...exec,agent:{session:{id:'other'}}}),/restricted/)
  await assert.rejects(tool.execute({queries:['']} ,exec),/Supply/)
  await assert.rejects(tool.execute({queries:Array(5).fill('词')},exec),/Supply/);assert.equal(calls,0)
  await assert.rejects(tool.execute({queries:['词']},exec),/no model-based fallback/);assert.equal(calls,1)
})
test('partial search failures retain successful candidates and unavailable provider never issues requests',async()=>{
  const {tool,exec}=fixture({available:()=>true,search:async({query})=>{if(query==='bad')throw Error('failed');return {sources:[{url:'https://example.org'}],truncated:false}}})
  const result=await tool.execute({queries:['bad','good']},exec);assert.equal(result.failed_requests,1);assert.equal(result.successful_requests,1);assert.equal(result.sources.length,1)
  const missing=fixture({available:()=>false});await assert.rejects(missing.tool.execute({queries:['词']},missing.exec),/unavailable/)
})
test('both-source search starts Bilibili and direct API together, deduplicates in-flight retries and renders only counts',async()=>{
  let tool,apiCalls=0,biliCalls=0,release
  const gate=new Promise(resolve=>{release=resolve}),started=[]
  registerFishSearch({tools:{register:t=>{tool=t}},web:{searchProviders:new Map([['deepseek-search-api',{available:()=>true,search:async()=>{apiCalls++;started.push('ds');await gate;return {sources:[{url:'https://example.org/page',snippet:'正文摘要'}],truncated:false}}}]])},acceptSession:()=>true,getRun:()=>({run_id:'r',resource_source:'both'}),searchBili:async()=>{biliCalls++;started.push('bili');await gate;return {candidates:[{bv:'BV0000000001',t:'原始视频',description:'真实简介'}]}}})
  const exec={agent:{session:{id:'fish'}},signal:new AbortController().signal}
  const a=tool.execute({queries:['工程维护']},exec),b=tool.execute({queries:['工程维护']},exec)
  await Promise.resolve();assert.deepEqual(started.sort(),['bili','ds']);release()
  const [first,second]=await Promise.all([a,b]);assert.deepEqual(first,second);assert.equal(apiCalls,1);assert.equal(biliCalls,1)
  assert.equal(first.bilibili.candidates.length,1);assert.equal(first.sources.length,1);assert.equal(first.billable_requests,1)
  const text=tool.output.render({},first)[0].text;assert.ok(text.length<600);assert.ok(!text.includes('真实简介'));assert.ok(!text.includes('正文摘要'))
})
test('one provider failing retains the other provider results without a model-based fallback',async()=>{
  for(const dsAvailable of [true,false]) {
    let tool
    registerFishSearch({tools:{register:t=>{tool=t}},web:{searchProviders:new Map([['deepseek-search-api',{available:()=>dsAvailable,search:async()=>{throw Error('DS failed')}}]])},acceptSession:()=>true,getRun:()=>({run_id:'r',resource_source:'both'}),searchBili:async()=>({candidates:[{bv:'BV0000000001',t:'B站候选'}]})})
    const result=await tool.execute({queries:['查询']},{agent:{session:{id:'fish'}}})
    assert.equal(result.sources.length,0);assert.equal(result.bilibili.candidates.length,1);assert.equal(result.billable_requests,0)
  }
})

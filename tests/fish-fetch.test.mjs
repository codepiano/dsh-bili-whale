import test from 'node:test'
import assert from 'node:assert/strict'
import {registerFishFetch} from '../lib/fish-fetch.js'
function tool(fetchProvider,acceptSession=id=>id==='fish') {let definition;registerFishFetch({tools:{register:d=>{definition=d}},web:{fetchProviders:new Map([['deepseek-fetch-api',fetchProvider]]),fetch:()=>assert.fail('global provider must not run')},acceptSession});return definition}
const exec={agent:{session:{id:'fish'}},signal:new AbortController().signal}
test('fetch chooses exact DS registry provider and returns compact receipt without rendering or truncating the body',async()=>{
  const body='正文😀'.repeat(30000);let count=0;
  const t=tool({available:()=>true,fetch:async(input,signal)=>{count++;assert.equal(input.url,'https://example.org/');assert.equal(signal,exec.signal);return {url:input.url,statusCode:200,body:{kind:'text',content:body},truncated:false}}});
  const value=await t.execute({url:'https://example.org/'},exec);assert.equal(value.provider,'deepseek-fetch-api');assert.equal(value.body.content,body);assert.equal(value.truncated,false);assert.equal(count,1);
  const rendered=t.output.render({},value)[0].text;assert.ok(rendered.length<600);assert.ok(!rendered.includes(body.slice(0,60)));assert.equal(JSON.parse(rendered).characters,body.length);
  await assert.rejects(t.execute({url:'https://example.org/'},{...exec,agent:{session:{id:'other'}}}),/restricted/);assert.equal(count,1);
  await assert.rejects(t.execute({url:'http://127.0.0.1/'},exec),/Local/);
})
test('unavailable, paid API failure and excessive body have explicit provider receipts and no fallback or secret text',async()=>{
  let t=tool({available:()=>false});assert.equal((await t.execute({url:'https://example.org/'},exec)).error_code,'DS_FETCH_UNAVAILABLE');
  t=tool({available:()=>true,fetch:async()=>{throw Object.assign(Error('DeepSeek API error (HTTP 404): secret body'),{code:'WEB_PROVIDER_ERROR'})}});
  let v=await t.execute({url:'https://example.org/'},exec);assert.equal(v.api_status,404);assert.equal(v.provider,'deepseek-fetch-api');assert.ok(!JSON.stringify(v).includes('secret'));
  t=tool({available:()=>true,fetch:async({url})=>({url,body:{kind:'text',content:'a'.repeat(2000001)},truncated:false})});v=await t.execute({url:'https://example.org/'},exec);assert.equal(v.error_code,'BODY_TOO_LARGE');assert.equal(v.truncated,true);assert.equal(v.body.content,'');
})

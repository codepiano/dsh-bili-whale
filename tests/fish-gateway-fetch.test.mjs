import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {registerFishGatewayFetch} from '../lib/fish-gateway-fetch.js'
import {webFetchGateway} from '../lib/web-fetch-gateway.js'
const exec={agent:{session:{id:'fish'}},signal:new AbortController().signal}
function setup(invoke){const tools={};registerFishGatewayFetch({tools:{register:d=>{tools[d.name]=d}},web:{fetchProviders:new Map([['deepseek-fetch-api',{available:()=>true}]])},acceptSession:id=>id==='fish',invoke});return tools}
test('all common backends are explicit model choices, credentials never enter tool inputs and results remain compact',async()=>{
 let calls=0;const tools=setup(async(command,args)=>{calls++;if(command==='backends')return {backends:['jina','opencli','deepseek'].map(name=>({name,configured:name!=='opencli',ready:'unchecked'}))};assert.equal(args.maxChars,100000);return {backend:args.backend,content:'实际网页正文'.repeat(1000),truncated:false,warnings:['Question returns previews only'],sourceCompleteness:'unverified'}});
 const catalog=await tools.fish_fetch_backends.execute({},exec);assert.equal(catalog.choices.length,5);assert.equal(catalog.choices.find(c=>c.backend==='opencli').configured,false);
 for(const backend of ['jina','opencli','deepseek']){const r=await tools.fish_gateway_fetch.execute({url:'https://example.org/',backend},exec);assert.equal(r.provider,'common-mcp:'+backend);assert.equal(r.provider_attempted,true);assert.deepEqual(r.warnings,['Question returns previews only']);const text=tools.fish_gateway_fetch.output.render({},r)[0].text;assert.ok(text.length<700);assert.ok(!text.includes('实际网页正文'));}
 assert.equal(calls,4);await assert.rejects(tools.fish_gateway_fetch.execute({url:'https://example.org/',backend:'shell'},exec),/Choose/);await assert.rejects(tools.fish_gateway_fetch.execute({url:'https://example.org/',backend:'jina'}, {...exec,agent:{session:{id:'other'}}}),/restricted/);assert.equal(calls,4);
})
test('gateway failures keep native and DS choices discoverable and never leak original errors',async()=>{
 const tools=setup(async()=>{throw Object.assign(Error('synthetic-secret'),{code:'GATEWAY_UNAVAILABLE'})});const catalog=await tools.fish_fetch_backends.execute({},exec);assert.ok(catalog.choices.some(c=>c.tool==='web_fetch'&&c.configured));assert.ok(catalog.choices.some(c=>c.tool==='fish_web_fetch'&&c.configured));const r=await tools.fish_gateway_fetch.execute({url:'https://example.org/',backend:'jina'},exec);assert.equal(r.provider_attempted,undefined);assert.ok(!JSON.stringify(r).includes('synthetic-secret'));
})
test('business bridge uses only the fixed loopback gateway, server-side bearer and selected Web Fetch command',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fish-fetch-gateway-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const envFile=path.join(dir,'env');await fs.writeFile(envFile,'PORT=4319\nGATEWAY_TOKEN=synthetic-private-token\n');
 const data=await webFetchGateway('read_url',{url:'https://example.org/',backend:'jina'},exec.signal,{envFile,fetchImpl:async(url,init)=>{assert.equal(url,'http://127.0.0.1:4319/api/services/web_fetch/commands/read_url');assert.equal(init.headers.Authorization,'Bearer synthetic-private-token');assert.equal(init.redirect,'error');assert.deepEqual(JSON.parse(init.body),{arguments:{url:'https://example.org/',backend:'jina'}});return Response.json({data:{content:'actual'}})}});assert.equal(data.content,'actual');
 await assert.rejects(webFetchGateway('read_url',{},exec.signal,{envFile,fetchImpl:async()=>Response.json({error:{message:'synthetic-private-token',upstreamStatus:429}},{status:429})}),e=>e.api_status===429&&!e.message.includes('synthetic-private-token'));
})

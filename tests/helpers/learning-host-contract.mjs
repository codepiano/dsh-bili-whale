// Run in a separate Electron Node process, never in the running DSH host:
// ELECTRON_RUN_AS_NODE=1 BILI_DSH_ASAR=/path/to/app.asar <Electron> tests/helpers/learning-host-contract.mjs
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {ObservationStore} from '../../tools/lib/concept-system/store.mjs'
import {Observer,attachSessionEvents} from '../../tools/lib/concept-system/observation.mjs'
import {createLearningHost} from '../../lib/learning-host.js'
import {VideoReads} from '../../tools/lib/concept-system/video-reads.mjs'

if(!process.env.BILI_DSH_ASAR)throw Error('Set BILI_DSH_ASAR to the installed host archive')
const require=createRequire(path.join(process.env.BILI_DSH_ASAR,'dsh','package.json'))
const {Context}=require('@deepseek-ai/cordis')
const {SystemPrompt,renderContextSnapshot}=require('@deepseek-ai/dsh-system-prompt')
const {createToolResultMessage}=require('@deepseek-ai/dsh-llm')
const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-host-contract-'))
const ctx=new Context(),sp=new SystemPrompt(ctx,{includeHarnessIdentity:false})
const store=new ObservationStore(root),observer=new Observer({store,paths:{}})
const config={conceptSystem:{observe:true,learning:true,mode:'active',renderBudget:400}}
const learning=createLearningHost({ctx,observer,config:()=>config,sessionIds:['fish'],start:false,evaluate:async job=>({candidates:[{
  subject:job.source.type==='video'?'fish':'user',content:'康德 {{literal}}',tags:['topic'],scene:'general',triggers:[],exclusions:[],interpretation:'mention',
  quote:'康德',status:'accepted',reason:'原文提及',collections:[{name:'哲学阅读',definition:'哲学阅读相关概念',boundary:'不据此推断个人认同',aliases:[],related:[],reason:'来源属于这一主题'}],
}]})})
let events=attachSessionEvents(ctx,observer,'fish',{onEvent:learning.onEvent})
try {
  await store.transaction({key:'feed-select:contract',input:'native'},()=>({mode:'shadow',selected:[{bv:'BV1234567890'}]}))
  const reads=new VideoReads(store),attempt=await reads.start('BV1234567890',{feed_run_id:'contract'})
  const receipt=await reads.complete(attempt.id,{bvid:'BV1234567890',cid:'123',duration:30,subtitles:[{from:0,to:4,content:'康德的思想'}]})
  ctx.emit('session/event',{id:'fish'},{type:'user/message',seq:1,time:Date.now(),data:{id:'owner-1',source:{kind:'user'},content:[{type:'text',text:'我最近想读康德'}]}})
  ctx.emit('session/event',{id:'fish'},{type:'request/header',seq:2,time:Date.now(),data:{header:{config:{provider:'deepseek-account',model:'fixture'}}}})
  ctx.emit('session/event',{id:'fish'},{type:'tool/result',seq:3,time:Date.now(),data:{turn:1,step:1,message:createToolResultMessage({callId:'debrief-1',content:[{type:'text',text:receipt.marker}],isError:false})}})
  await events.stop()
  events=attachSessionEvents(ctx,observer,'fish',{onEvent:learning.onEvent})
  assert.equal(store.events({type:'learning.enqueued'}).length,1,'metadata receipt does not enqueue the subtitle source')
  const page=await reads.page({read_id:receipt.id,page:1})
  ctx.emit('session/event',{id:'fish'},{type:'tool/result',seq:4,time:Date.now(),data:{turn:1,step:2,message:createToolResultMessage({callId:'page-1',content:[{type:'text',text:JSON.stringify(page)}],isError:false})}})
  ctx.emit('session/event',{id:'fish'},{type:'session-log-deepseek/delivery-accepted',seq:5,time:Date.now(),data:{sessionId:'fish',throughSeq:4}})
  ctx.emit('session/event',{id:'fish'},{type:'turn/end',seq:6,time:Date.now(),data:{}})
  await events.stop();await learning.worker.wake()
  assert.equal(store.events({type:'learning.completed'}).length,2)
  assert.equal((await reads.get(receipt.id)).status,'assessed')
  assert.equal((await reads.get(receipt.id)).delivery.through_seq,4)
  const agent={session:{id:'fish'}}
  const assembly=await sp.assemble({agent})
  const text=renderContextSnapshot(sp.refreshContext(assembly,{agent}))
  assert.match(text,/康德 \{\{literal\}\}/)
  assert.equal(assembly.contexts.filter(c=>c.name==='bili-whale-learning-context').length,1)
  assert.equal(renderContextSnapshot(await sp.assemble({agent:{session:{id:'other'}}})), '')
  const empty={kind:'enter',messages:[]}
  const result=await ctx.waterfall('agent/pre-step',{agent,turn:1,step:2,signal:new AbortController().signal},()=>Promise.resolve(empty))
  assert.equal(result,empty)
  assert.equal(result.messages.length,0)
  config.conceptSystem.mode='shadow'
  assert.equal(renderContextSnapshot(await sp.assemble({agent})), '')
  console.log(JSON.stringify({ok:true,node:process.versions.node,checks:['native Cordis event ingestion','native tool-result receipt ingestion','metadata cannot complete subtitle reading','full subtitle pages delivered before learning','automatic video assessment','native SystemPrompt assemble/refresh/render','literal context','session isolation','empty-step termination preserved','shadow mode']}))
} finally {
  await events.stop();await learning.stop();fs.rmSync(root,{recursive:true,force:true})
}

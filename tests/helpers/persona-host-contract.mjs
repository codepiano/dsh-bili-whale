// Isolated Electron Node process against installed native Cordis/SystemPrompt.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {ObservationStore} from '../../tools/lib/concept-system/store.mjs'
import {Observer,attachSessionEvents} from '../../tools/lib/concept-system/observation.mjs'
import {createLearningHost} from '../../lib/learning-host.js'
import {LearningQueue} from '../../tools/lib/concept-system/learning.mjs'
const require=createRequire(path.join(process.env.BILI_DSH_ASAR,'dsh/package.json'))
const {Context}=require('@deepseek-ai/cordis'),{SystemPrompt,renderContextSnapshot}=require('@deepseek-ai/dsh-system-prompt')
const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-persona-native-')),file=path.join(root,'persona.md')
fs.writeFileSync(file,'# 我怎么说\n少说空话。\n')
const store=new ObservationStore(path.join(root,'data')),ctx=new Context(),sp=new SystemPrompt(ctx,{includeHarnessIdentity:false}),q=new LearningQueue(store)
const source={id:'owner',actor:'user',type:'conversation',excerpt:'请先说哪里还有缺口，不要只报告完成。',ref:'fixture:owner'}
await q.enqueue({session_id:'fish',source,route:{provider:'fixture',model:'fixture'}});await q.ready('fish');const job=await q.claim();await q.update(job,{status:'done'},'learning.completed')
const config={conceptSystem:{observe:true,learning:true,mode:'active',renderBudget:400,personaRevision:true}}
const learning=createLearningHost({ctx,observer:new Observer({store,paths:{}}),config:()=>config,sessionIds:['fish'],personaRevision:true,personaFile:file,start:false,revise:async()=>({reason:'用户明确纠正报告方式',edits:[{before:'少说空话。',after:'少说空话。先说明还缺什么。',reason:'引用用户纠正',trigger:'feedback',evidence:[{source_id:'owner',quote:source.excerpt}]}]})})
const events=attachSessionEvents(ctx,new Observer({store,paths:{}}),'fish',{onEvent:learning.onEvent})
try{
 await learning.revision.wake()
 const assembly=await sp.assemble({agent:{session:{id:'fish'}}}),snapshot=sp.refreshContext(assembly,{agent:{session:{id:'fish'}}})
 assert.match(renderContextSnapshot(snapshot),/先说明还缺什么/)
 assert.equal(renderContextSnapshot(await sp.assemble({agent:{session:{id:'other'}}})), '')
 const section=assembly.contexts.find(c=>c.name==='bili-whale-persona-context')
 ctx.emit('session/event',{id:'fish'},{type:'user/message',seq:10,time:Date.now(),data:{id:'native-context',source:{kind:'runtime-context',sections:[{name:section.name,text:section.text}]},content:[{type:'text',text:renderContextSnapshot(snapshot)}]}})
 ctx.emit('session/event',{id:'fish'},{type:'session-log-deepseek/delivery-accepted',seq:11,time:Date.now(),data:{sessionId:'fish',throughSeq:10}})
 await events.stop()
 assert.equal(store.events({type:'persona.context_delivered'}).length,1)
 const state=store.state().persona_revision,revision=state.history[0]
 await learning.revision.manager.rollback({revision_id:revision.id,expected_hash:revision.after_hash,reason:'隔离恢复验证'})
 assert.match(renderContextSnapshot(await sp.assemble({agent:{session:{id:'fish'}}})),/少说空话/)
 assert.doesNotMatch(fs.readFileSync(file,'utf8'),/先说明还缺什么/)
 config.conceptSystem.mode='shadow';assert.equal(renderContextSnapshot(await sp.assemble({agent:{session:{id:'fish'}}})), '')
 console.log(JSON.stringify({ok:true,node:process.versions.node,checks:['idle reflection','atomic persona revision','native SystemPrompt persona injection','session isolation','native admission and provider acknowledgement','versioned rollback','shadow mode']}))
}finally{await events.stop();await learning.stop();fs.rmSync(root,{recursive:true,force:true})}

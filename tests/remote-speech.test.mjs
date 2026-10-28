import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-cloud-speech-'))
Object.assign(process.env,{HOME:home,USERPROFILE:home,DSH_HOME:home,BILI_SPEECH_TOKEN:'fixture-token-never-print'})
const {transcribeVideoAudio,pollVideoAudio,speechStateFile}=await import('../tools/lib/video-audio.mjs')
const {ObservationStore}=await import('../tools/lib/concept-system/store.mjs')
const {VideoReads}=await import('../tools/lib/concept-system/video-reads.mjs')
const {pollAudioRead}=await import('../tools/lib/concept-system/audio-reads.mjs')
test.after(()=>fs.rmSync(home,{recursive:true,force:true}))
const uploadId='22222222-2222-4222-8222-222222222222'
const id='11111111-1111-4111-8111-111111111111',settings={baseUrl:'http://127.0.0.1:4325/api/',provider:'doubao'}
const result={text:'实际原文。',segments:[{startMs:1000,endMs:5000,text:'实际原文。'}],durationMs:6000,silence:false}
const catalog={uploads:{configured:true,maxBytes:512000000},backends:[{name:'doubao',configured:true,processing:'cloud',capabilities:{timestamps:true},resourceId:'volc.seedasr.auc'}]}
function playback(){return {code:0,data:{dash:{audio:[{baseUrl:'https://fixture.bilivideo.com/audio.m4a?deadline=1&sign=private-fixture'}]}}}}

const bytes=Buffer.from('fixture audio')
const sha=crypto.createHash('sha256').update(bytes).digest('hex')
const md5=crypto.createHash('md5').update(bytes).digest('base64')
const grant={uploadId,upload:{method:'POST',url:'https://fixture.tos-cn-beijing.volces.com/',fields:{key:'speech-temp/fixture',policy:'sensitive-upload-grant','Content-MD5':md5}}}
const download=async(_url,file,{headers}={})=>{assert.equal(headers?.cookie,'bili-only');fs.writeFileSync(file,bytes,{mode:0o600})}
const inputFor=(bvid,fetchImpl)=>({bvid,cid:123,headers:{cookie:'bili-only'},jget:async()=>playback(),settings,fetchImpl,download})

test('managed upload is streamed, credentials stay scoped and lost submit response reuses the same paid identity',async()=>{
 let network=[],bili=0,submits=0,uploads=0,state='queued'
 const fetchImpl=async(url,options)=>{
  const u=String(url);network.push({url:u,options})
  assert.equal(options.headers?.cookie,undefined)
  if(u.endsWith('/backends'))return Response.json(catalog)
  if(u.endsWith('/audio-uploads')) {
   const body=JSON.parse(options.body);assert.equal(body.byteLength,bytes.length);assert.equal(body.contentMd5,md5)
   return Response.json(grant)
  }
  if(u===grant.upload.url) {
   uploads++;assert.equal(options.headers,undefined,'neither speech token nor Bilibili cookie can accompany TOS upload')
   assert.equal(options.body.get('policy'),'sensitive-upload-grant')
   assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()),bytes)
   return new Response(null,{status:204})
  }
  if(u.endsWith('/transcriptions')) {submits++;if(submits===1)throw Error('response lost after acceptance');return Response.json({id,provider:'doubao',status:state})}
  assert.ok(u.endsWith('/wait'));return Response.json({id,provider:'doubao',status:state,completed:state==='succeeded',waitTimedOut:state!=='succeeded',...(state==='succeeded'?{result}:{})})
 }
 const input={...inputFor('BV1234567890',fetchImpl),jget:async()=>{bili++;return playback()}}
 const first=await transcribeVideoAudio(input);assert.equal(first.status,'pending');assert.equal(first.speech.task_id,null)
 const file=speechStateFile(first.speech.key),saved=JSON.parse(fs.readFileSync(file,'utf8'))
 assert.equal(fs.statSync(file).mode&0o777,0o600)
 assert.equal(saved.input.uploadId,uploadId);assert.equal(saved.input.audioUrl,undefined)
 assert.ok(!fs.readFileSync(file,'utf8').includes('sensitive-upload-grant'),'presigned upload credentials must not persist')
 assert.ok(!fs.readFileSync(file,'utf8').includes('private-fixture'),'Bilibili signed URLs must not persist')
 assert.equal(fs.existsSync(file.replace(/\.json$/,'.m4a')),false,'local audio is deleted as soon as TOS confirms upload')
 const again=await transcribeVideoAudio(input);assert.equal(again.status,'pending');assert.equal(submits,1);assert.equal(bili,1);assert.equal(uploads,1)
 const recovered=await pollVideoAudio(first.speech.key,{settings,fetchImpl,now:()=>Date.now()+31000})
 assert.equal(recovered.speech.task_id,id);assert.equal(submits,2)
 const posts=network.filter(r=>r.url.endsWith('/transcriptions')).map(r=>JSON.parse(r.options.body))
 assert.deepEqual(posts[0],posts[1],'uncertain recovery reuses exact uploadId, options and request identity')
 state='succeeded'
 const complete=await pollVideoAudio(first.speech.key,{settings,fetchImpl,now:()=>Date.now()+62000})
 assert.equal(complete.status,'success');assert.equal(complete.rows[0].from,1);assert.equal(complete.rows[0].to,5)
 assert.equal(complete.provenance.engine,'common-mcp-speech');assert.equal(complete.provenance.task_id,id)
 assert.equal(complete.provenance.audio_hash,sha);assert.equal(complete.provenance.upload_id,uploadId)
 const count=network.length;assert.deepEqual(await transcribeVideoAudio(input),complete);assert.equal(network.length,count)
})

test('cloud result without complete timestamps is never presented as a full transcript',async()=>{
 const fetchImpl=async(url,options)=>{
  if(String(url).endsWith('/backends'))return Response.json(catalog)
  if(String(url).endsWith('/audio-uploads'))return Response.json(grant)
  if(String(url)===grant.upload.url)return new Response(null,{status:204})
  return Response.json({id,provider:'doubao',status:'succeeded',result:{...result,segments:[{text:'实际',startMs:0,endMs:2}]}})
 }
 const r=await transcribeVideoAudio(inputFor('BV1234567891',fetchImpl))
 assert.equal(r.status,'unavailable');assert.equal(r.reason,'speech_result_missing_complete_timestamps')
})

test('local backend, unconfigured staging and missing credentials do not fetch audio or run a local fallback',async()=>{
 for(const data of [{...catalog,backends:[{...catalog.backends[0],processing:'host-local'}]},{...catalog,uploads:{configured:false}}]) {
  const r=await transcribeVideoAudio({...inputFor('BV1234567892',async()=>Response.json(data)),jget:()=>{throw Error('must not fetch')}})
  assert.equal(r.status,'unavailable')
 }
 const token=process.env.BILI_SPEECH_TOKEN;delete process.env.BILI_SPEECH_TOKEN
 try{assert.equal((await transcribeVideoAudio({settings,jget:()=>{throw Error('must not fetch')}})).reason,'speech_credentials_missing')}finally{process.env.BILI_SPEECH_TOKEN=token}
})

test('unconfirmed TOS upload keeps the same transfer and reservation and cannot submit paid transcription',async()=>{
 let submit=0,uploadKeys=[]
 const fetchImpl=async(url,options)=>{
  if(String(url).endsWith('/backends'))return Response.json(catalog)
  if(String(url).endsWith('/audio-uploads')){uploadKeys.push(JSON.parse(options.body).clientRequestId);return Response.json(grant)}
  if(String(url)===grant.upload.url)throw Error('TOS response lost')
  submit++;throw Error('must not submit')
 }
 const first=await transcribeVideoAudio(inputFor('BV1234567894',fetchImpl))
 assert.equal(first.status,'pending');assert.equal(submit,0)
 assert.equal(fs.existsSync(speechStateFile(first.speech.key).replace(/\.json$/,'.m4a')),true)
 await pollVideoAudio(first.speech.key,{settings,fetchImpl,now:()=>Date.now()+31000})
 assert.equal(uploadKeys.length,2);assert.equal(uploadKeys[0],uploadKeys[1]);assert.equal(submit,0)
})

test('an already-bound upload reservation recovers its task without upload credentials or another submission',async()=>{
 let submit=0
 const fetchImpl=async(url,options)=>{
  if(String(url).endsWith('/backends'))return Response.json(catalog)
  if(String(url).endsWith('/audio-uploads'))return Response.json({uploadId,taskId:id,state:'deleted'})
  if(String(url).endsWith('/transcriptions')){submit++;throw Error('must not submit')}
  return Response.json({id,provider:'doubao',status:'succeeded',result})
 }
 const done=await transcribeVideoAudio(inputFor('BV1234567895',fetchImpl))
 assert.equal(done.status,'success');assert.equal(done.provenance.upload_id,uploadId);assert.equal(submit,0)
})

test('pending task completion records acquisition first and still needs real body delivery before exposure',async()=>{
 const store=new ObservationStore(path.join(home,'observations')),reads=new VideoReads(store)
 await store.transaction({key:'feed-select:remote-read',input:'fixture'},()=>({mode:'shadow',selected:[{bv:'BV1234567890'}]}))
 const attempt=await reads.start('BV1234567890',{feed_run_id:'remote-read'})
 await reads.deferAudio(attempt.id,{bvid:attempt.bvid,cid:123,duration:6,subtitles:[],description:'简介',components:{audio:'pending'}},{key:'a'.repeat(64),task_id:id})
 assert.deepEqual(reads.seen(),[]);assert.equal(store.events({type:'learning.enqueued'}).length,0)
 let calls=0
 const pending=await pollAudioRead(store,{read_id:attempt.id},{poll:async()=>({status:'pending',speech:{task_id:id}})})
 assert.equal(pending.status,'pending');assert.equal((await reads.get(attempt.id)).status,'audio_pending')
 const completed=await pollAudioRead(store,{read_id:attempt.id},{poll:async()=>{calls++;return {status:'success',rows:[{from:1,to:5,content:result.text}],provenance:{engine:'common-mcp-speech',provider:'doubao',task_id:id,resource_id:'volc.seedasr.auc',audio_url_hash:'b'.repeat(64)}}}})
 assert.match(completed.receipt_marker,/BILI_DEBRIEF_RECEIPT/);assert.equal((await reads.get(attempt.id)).status,'acquired')
 const replay=await pollAudioRead(store,{read_id:attempt.id},{poll:()=>{throw Error('already completed')}})
 assert.equal(replay.receipt_marker,completed.receipt_marker);assert.equal(calls,1)
 assert.equal(store.events({type:'learning.enqueued'}).length,0)
 await reads.acceptOutput(completed.receipt_marker,{session_id:'fish',route:{provider:'deepseek-account',model:'fixture'}})
 assert.equal(store.events({type:'learning.enqueued'}).length,0,'task completion and receipt do not replace body delivery')
 const page=await reads.page({read_id:attempt.id,page:1})
 await reads.acceptOutput(JSON.stringify(page),{session_id:'fish',host_seq:10})
 assert.deepEqual(reads.seen(),[])
 await reads.acceptDelivery({session_id:'fish',through_seq:10,host_seq:11})
 assert.equal(store.events({type:'learning.enqueued'}).length,1);assert.deepEqual(reads.seen(),['BV1234567890'])
 const record=await reads.get(attempt.id),source=store.getObject(record.sources[0].object.hash).content
 assert.equal(source.video.transcription.engine,'common-mcp-speech');assert.equal(source.video.transcription.task_id,id)
})

test('a later scheduled wake resumes the original pending audio cycle without another selection or paid submission',async()=>{
 const {nextExploration}=await import('../tools/lib/concept-system/auto-exploration.mjs')
 const store=new ObservationStore(path.join(home,'resume-cycle')),reads=new VideoReads(store),video={bv:'BV1234567893'}
 await store.transaction({},(d)=>{d.state.auto_exploration_cycles={old:{id:'old',round:1,max_rounds:3,n:1,per:2,pool:30,source:'search',status:'active'}}})
 await store.transaction({key:'feed-select:old-r1',input:'fixture'},()=>({mode:'shadow',selected:[video]}))
 const read=await reads.start(video.bv,{feed_run_id:'old-r1'})
 await reads.deferAudio(read.id,{bvid:video.bv,cid:126,duration:6,components:{audio:'pending'}},{key:'c'.repeat(64),task_id:id})
 let feedCalls=0
 const next=await nextExploration(store,{cycle_id:'new-wake'},{readConfig:()=>({conceptSystem:{observe:true,mode:'active'}}),feed:async args=>{feedCalls++;assert.equal(args.run_id,'old-r1');return {selected:[video]}}})
 assert.equal(next.cycle_id,'old');assert.equal(next.next_action,'video_audio_status');assert.equal(next.arguments.read_id,read.id)
 assert.equal(store.state().auto_exploration_cycles['new-wake'],undefined);assert.equal(feedCalls,1)
 assert.equal(store.events({type:'exploration.exposed'}).length,0)
})

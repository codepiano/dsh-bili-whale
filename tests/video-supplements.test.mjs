import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const home=fs.mkdtempSync(path.join(os.tmpdir(),'whale-supplements-'))
Object.assign(process.env,{HOME:home,USERPROFILE:home,DSH_HOME:path.join(home,'profile')})
const {ObservationStore,hash}=await import('../tools/lib/concept-system/store.mjs')
const {VideoReads,videoMaterial}=await import('../tools/lib/concept-system/video-reads.mjs')
const {transcribeLocalFile,transcribeVideoAudio,downloadMedia,fileHash}=await import('../tools/lib/video-audio.mjs')
const {readVideoFrames,frameToolContent}=await import('../tools/lib/video-frames.mjs')
test.after(()=>fs.rmSync(home,{recursive:true,force:true}))
const provenance={engine:'whisper.cpp',model:'fixture',model_hash:'a'.repeat(64),audio_hash:'b'.repeat(64),chunk_seconds:240}

test('audio chunks cover the input, preserve offsets, cache identical inputs, and clean intermediates on failure',async()=>{
 const audio=path.join(home,'input.m4a'),model=path.join(home,'ggml-fixture.bin');fs.writeFileSync(audio,'audio');fs.writeFileSync(model,'model')
 const settings={model,executable:process.execPath},commands=[]
 const execute=async(file,args)=>{commands.push(args);if(args.includes('-oj'))fs.writeFileSync(args[args.indexOf('-of')+1]+'.json',JSON.stringify({transcription:[{offsets:{from:0,to:2000},text:'实际话语'}]}));else fs.writeFileSync(args.at(-1),'wav')}
 const result=await transcribeLocalFile(audio,{duration:481,settings,execute})
 assert.deepEqual(result.rows.map(r=>r.from),[0,240,480]);assert.equal(result.rows.at(-1).to,481)
 assert.equal(result.provenance.audio_hash,hash('audio'));assert.equal(result.provenance.model_hash,hash('model'))
 const count=commands.length;const cached=await transcribeLocalFile(audio,{duration:481,settings,execute:()=>{throw Error('cache miss')}})
 assert.deepEqual(cached,result);assert.equal(commands.length,count)
 const chunk=commands[0].at(-1);assert.equal(fs.existsSync(chunk),false)
 await assert.rejects(transcribeLocalFile(audio,{duration:1,settings:{...settings,cache:false},execute:async()=>{throw Error('fixture failure')}}),/fixture failure/)
})

test('missing or disabled ASR and excessive duration do not fetch media',async()=>{
 for(const settings of [{enabled:false},{model:path.join(home,'missing')},{model:path.join(home,'ggml-fixture.bin'),executable:process.execPath}]) {
  const result=await transcribeVideoAudio({bvid:'BV1234567890',cid:123,duration:9000,settings,jget:()=>{throw Error('unexpected request')}})
  assert.equal(result.status,'unavailable')
 }
 await assert.rejects(downloadMedia('http://localhost/private',path.join(home,'bad'),{fetch:()=>{throw Error('must not fetch')}}),/Unexpected media host/)
 await assert.rejects(downloadMedia('https://fixture.bilivideo.com/audio',path.join(home,'large'),{fetch:async()=>new Response('oversize'),maxBytes:2}),/size limit/)
})

test('audio truncation is explicit and human subtitle identity stays distinct from transcript identity',()=>{
 const base={bvid:'BV1234567890',cid:123,duration:20,subtitles:[{from:0,to:2,content:'相同原文'}]}
 const sub=videoMaterial(base),audio=videoMaterial({...base,transcript:{force:true,rows:base.subtitles,provenance}})
 assert.equal(sub.kind,'subtitles');assert.equal(audio.kind,'audio_transcript');assert.equal(audio.coverage.subtitle_lines,0);assert.equal(audio.coverage.transcript_segments,1);assert.notEqual(sub.sources[0].id,audio.sources[0].id)
 const long=videoMaterial({...base,transcript:{force:true,rows:[{from:0,to:5,content:'字'.repeat(4001)}],provenance}})
 assert.equal(long.coverage.truncated,true)
})

test('frames require a real receipt, validate timestamps and persist image hashes linked to the original read',async()=>{
 fs.mkdirSync(path.join(home,'.bili-ai'),{recursive:true});fs.writeFileSync(path.join(home,'.bili-ai','credentials.json'),JSON.stringify({sessdata:'fixture',bili_jct:'fixture',buvid3:'fixture'}))
 const store=new ObservationStore(path.join(home,'concepts')),reads=new VideoReads(store),attempt=await reads.start('BV1234567890')
 const receipt=await reads.complete(attempt.id,{bvid:attempt.bvid,cid:123,duration:30,subtitles:[{from:0,to:5,content:'原文'}]})
 await assert.rejects(readVideoFrames(store,{read_id:attempt.id,times:[3],reason:'图表'}),/real presented/)
 await reads.acceptOutput(receipt.marker,{session_id:'fish',learn:false})
 await assert.rejects(readVideoFrames(store,{read_id:attempt.id,times:[30],reason:'图表'}),/timestamps/)
 const images=await readVideoFrames(store,{read_id:attempt.id,times:[3,15],reason:'核实图表中的刻度'},{jget:async()=>({code:0,data:{dash:{video:[{baseUrl:'https://fixture.bilivideo.com/video'}]}}}),download:async(_,file)=>fs.writeFileSync(file,'fixture video'),execute:async(_,args)=>fs.writeFileSync(args.at(-1),Buffer.from([0xff,0xd8,0xff,0xd9]))})
 const blocks=frameToolContent(images)
 assert.equal(blocks.filter(b=>b.type==='image').length,2);assert.equal(blocks[2].mimeType,'image/jpeg')
 assert.equal(JSON.parse(blocks[0].text).images,undefined,'base64 must be native image content, not a text path or blob')
 assert.equal(images.images.length,2);assert.deepEqual(images.frames.map(f=>f.time),[3,15])
 assert.equal(images.material_hash,receipt.material_hash)
 for(const frame of images.frames)assert.equal(await fileHash(frame.path),frame.hash)
 const event=store.events({type:'video.frames_acquired'})[0]
 assert.equal(event.session_id,'fish');assert.equal(event.data.read_id,attempt.id)
 assert.match(event.data.scope,/acquired_not_whole/)
 assert.equal(store.events({type:'video.subtitle_read_completed'}).length,0)
})

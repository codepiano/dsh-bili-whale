// Local-only ASR. No audio or account-bearing media URL is sent to a cloud API.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {pipeline} from 'node:stream/promises'
import {Readable,Transform} from 'node:stream'
import {guardedFetch as fetch} from './traffic.mjs'
import {requireFfmpeg} from './ffmpeg.mjs'
import {HOME,dshPath} from './paths.mjs'
const run=promisify(execFile)
export const ASR_DEADLINE_MS=25*60*1000
export function localAsrSettings(settings={}) {
  const name=settings.model??process.env.BILI_WHISPER_MODEL??process.env.FFMPEG_SKILL_ASR_MODEL??'base'
  const model=path.isAbsolute(name)?name:path.join(HOME,'.cache','whisper.cpp',`ggml-${name}.bin`)
  const executable=settings.executable??process.env.BILI_WHISPER_BIN??'whisper-cli'
  const command=path.isAbsolute(executable)?executable:(process.env.PATH??'').split(path.delimiter).map(p=>path.join(p,executable)).find(p=>fs.existsSync(p))
  if(settings.enabled===false)return {ready:false,reason:'local_asr_disabled'}
  if(!command||!fs.existsSync(model))return {ready:false,reason:'local_whisper_or_model_missing'}
  return {ready:true,command,model}
}
export async function fileHash(file) {
  const digest=crypto.createHash('sha256')
  for await(const chunk of fs.createReadStream(file))digest.update(chunk)
  return digest.digest('hex')
}
export async function downloadMedia(url,file,{headers={},signal,fetch:fetchMedia=fetch,maxBytes=512*1024*1024}={}) {
  // Playback URLs originate from Bilibili. They are never logged or persisted.
  const u=new URL(url)
  if(!['http:','https:'].includes(u.protocol)||!/(^|\.)(bilivideo\.(com|cn)|hdslb\.com)$/.test(u.hostname))throw Error('Unexpected media host')
  const response=await fetchMedia(u.href,{headers,signal})
  if(!response.ok||!response.body)throw Error('Media download HTTP '+response.status)
  let bytes=0
  await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,done){
    bytes+=chunk.length;done(bytes>maxBytes?Error('Media size limit exceeded'):null,chunk)
  }}),fs.createWriteStream(file,{mode:0o600}),{signal})
  if(!bytes)throw Error('Empty media')
}
export async function transcribeLocalFile(file,{duration,settings={},signal,execute=run}={}) {
  const local=localAsrSettings(settings)
  if(!local.ready)return {status:'unavailable',reason:local.reason}
  if(!Number.isFinite(duration)||duration<=0||duration>7200)throw Error('Local ASR supports audio up to two hours')
  const scope=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(ASR_DEADLINE_MS)])
  const rows=[],chunkSeconds=240
  const audioHash=await fileHash(file),modelHash=await fileHash(local.model)
  const cacheKey=crypto.createHash('sha256').update(JSON.stringify(['whisper.cpp-v1',audioHash,modelHash,duration,chunkSeconds])).digest('hex')
  const cacheFile=dshPath('shots','asr-cache',cacheKey+'.json')
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-asr-'))
  try {
    if(settings.cache!==false) {
      try {
        const cached=JSON.parse(fs.readFileSync(cacheFile,'utf8'))
        const digest=crypto.createHash('sha256').update(JSON.stringify(cached.result)).digest('hex')
        if(cached.hash===digest&&cached.result?.provenance?.audio_hash===audioHash&&cached.result?.provenance?.model_hash===modelHash&&cached.result?.status==='success')return cached.result
      } catch {}
    }
    for(let offset=0;offset<duration;offset+=chunkSeconds) {
      scope.throwIfAborted()
      const wav=path.join(dir,'chunk.wav'),output=path.join(dir,'result')
      fs.rmSync(output+'.json',{force:true})
      await execute(requireFfmpeg(),['-nostdin','-y','-loglevel','error','-ss',String(offset),'-i',file,'-t',String(Math.min(chunkSeconds,duration-offset)),'-vn','-ac','1','-ar','16000',wav],{signal:scope,timeout:120000,maxBuffer:1024*1024})
      await execute(local.command,['-m',local.model,'-f',wav,'-l','auto','-mc','0','-oj','-of',output],{signal:scope,timeout:300000,maxBuffer:4*1024*1024})
      const result=JSON.parse(fs.readFileSync(output+'.json','utf8'))
      if(!Array.isArray(result.transcription))throw Error('Whisper did not return timed transcription')
      for(const part of result.transcription) {
        const from=Number(part.offsets?.from)/1000,to=Number(part.offsets?.to)/1000,content=String(part.text??'').trim()
        if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<from||to>Math.min(chunkSeconds,duration-offset)+1)throw Error('Invalid ASR timestamps')
        if(content)rows.push({from:offset+from,to:Math.min(duration,offset+to),content})
      }
    }
    if(!rows.length)return {status:'empty',reason:'no_recognized_speech'}
    const result={status:'success',rows,provenance:{engine:'whisper.cpp',model:path.basename(local.model),model_hash:modelHash,audio_hash:audioHash,chunk_seconds:chunkSeconds}}
    if(settings.cache!==false) {
      fs.mkdirSync(path.dirname(cacheFile),{recursive:true,mode:0o700})
      const tmp=cacheFile+'.'+crypto.randomUUID()+'.tmp'
      try {fs.writeFileSync(tmp,JSON.stringify({hash:crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex'),result}),{mode:0o600});fs.renameSync(tmp,cacheFile)}finally{fs.rmSync(tmp,{force:true})}
    }
    return result
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
}
export async function transcribeVideoAudio({bvid,cid,duration,headers,jget,settings={},signal,transcribe=transcribeLocalFile,download=downloadMedia}) {
  const local=localAsrSettings(settings)
  if(!local.ready)return {status:'unavailable',reason:local.reason}
  if(!Number.isFinite(duration)||duration<=0||duration>7200)return {status:'unavailable',reason:'audio_duration_outside_local_limit'}
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-audio-'))
  try {
    const playback=await jget(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&qn=16`)
    if(playback.code!==0)throw Error('Audio playback request failed: '+playback.code)
    const audio=playback.data?.dash?.audio?.slice().sort((a,b)=>(a.bandwidth??0)-(b.bandwidth??0))[0]
    if(!audio)return {status:'unavailable',reason:'no_separate_audio_stream'}
    const file=path.join(dir,'audio.m4a')
    await download(audio.baseUrl??audio.base_url,file,{headers,signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(120000)]),maxBytes:128*1024*1024})
    return await transcribe(file,{duration,settings,signal})
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
}

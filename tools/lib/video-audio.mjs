// All speech recognition is delegated to common-mcp's speech HTTP service.
// Only bounded audio transfer and checksums run locally; no decoding or ASR.
import fs,{openAsBlob} from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {downloadMedia} from './media-files.mjs'
import {dshPath} from './paths.mjs'
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function speechSettings(settings={}) {
  const baseUrl=settings.baseUrl??process.env.BILI_SPEECH_API_URL??'http://127.0.0.1:4325/api/'
  const url=new URL(baseUrl)
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Invalid speech API URL')
  if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Remote speech API requires HTTPS')
  let token=process.env.BILI_SPEECH_TOKEN??process.env.SPEECH_SERVICE_TOKEN
  const envFile=settings.envFile??process.env.BILI_SPEECH_ENV_FILE
  if(!token&&envFile) {
    try {
      const line=fs.readFileSync(envFile,'utf8').split(/\r?\n/).find(l=>/^\s*(?:export\s+)?SPEECH_SERVICE_TOKEN=/.test(l))
      token=line?.slice(line.indexOf('=')+1).trim().replace(/^(['"])(.*)\1$/,'$2')
    } catch {}
  }
  return {ready:settings.enabled!==false&&!!token,baseUrl:url.href.replace(/\/?$/,'/'),token,provider:settings.provider??'doubao',reason:settings.enabled===false?'speech_disabled':'speech_credentials_missing'}
}
async function api(cfg,route,{body,signal,fetchImpl=globalThis.fetch}={}) {
  const response=await fetchImpl(new URL(route,cfg.baseUrl),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+cfg.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(40000)])})
  if(!response.ok) {
    const error=Error('Speech API HTTP '+response.status);error.status=response.status
    // No backend error body, upload credential or signed URL is logged.
    await response.body?.cancel();throw error
  }
  let bytes=0;const chunks=[]
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>8*1024*1024)throw Error('Speech result exceeds size limit');chunks.push(chunk)}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export function speechStateFile(key) {
  if(!/^[a-f0-9]{64}$/.test(key))throw Error('Invalid speech state identity')
  return dshPath('speech-tasks',key+'.json')
}
function save(file,state) {
  const tmp=file+'.'+crypto.randomUUID()+'.tmp'
  try{fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});fs.renameSync(tmp,file)}finally{fs.rmSync(tmp,{force:true})}
}
function transcriptResult(state,key) {
  const job=state.job
  const speech={key,task_id:job?.id??null,provider:job?.provider??state.input.provider,resource_id:state.resourceId,...(state.audioHash?{audio_hash:state.audioHash}:{}),...(state.input.uploadId?{upload_id:state.input.uploadId}:{}),...(state.urlHash?{audio_url_hash:state.urlHash}:{})}
  const pending={status:'pending',reason:job?.status??'submission_unknown',speech,retry_after_seconds:30}
  if(!job||!['succeeded','failed'].includes(job.status))return pending
  if(job.status==='failed')return {status:'failed',reason:'speech_recognition_failed',speech:pending.speech}
  const result=job.result
  if(result?.silence===true)return {status:'empty',reason:'no_recognized_speech',speech:pending.speech}
  if(!result||typeof result.text!=='string'||!Array.isArray(result.segments))throw Error('Invalid speech transcript result')
  const segments=result.segments.filter(s=>typeof s.text==='string'&&s.text.trim())
  // Never discard untimed or unaligned words and then claim a complete read.
  const text=segments.map(s=>s.text).join('').replace(/\s/g,'')
  if(!segments.length||text!==result.text.replace(/\s/g,'')||segments.some(s=>!Number.isFinite(s.startMs)||!Number.isFinite(s.endMs)||s.startMs<0||s.endMs<s.startMs))return {status:'unavailable',reason:'speech_result_missing_complete_timestamps',speech:pending.speech}
  return {status:'success',rows:segments.map(s=>({from:s.startMs/1000,to:s.endMs/1000,content:s.text})),provenance:{engine:'common-mcp-speech',provider:job.provider,task_id:job.id,resource_id:state.resourceId,...(state.audioHash?{audio_hash:state.audioHash,upload_id:state.input.uploadId}:{}),...(state.urlHash?{audio_url_hash:state.urlHash}:{})},speech:pending.speech}
}
function audioFile(key) {return speechStateFile(key).replace(/\.json$/,'.m4a')}
async function ensureUpload(cfg,state,key,{signal,fetchImpl=globalThis.fetch}={}) {
  if(state.input.uploadId||state.input.audioUrl)return null // resume existing identities, including old URL tasks
  const grant=await api(cfg,'audio-uploads',{body:state.uploadRequest,signal,fetchImpl})
  if(!uuid.test(grant.uploadId))throw Error('Invalid audio upload identity')
  if(grant.taskId) {
    if(!uuid.test(grant.taskId))throw Error('Invalid bound speech task identity')
    state.input.uploadId=grant.uploadId;save(speechStateFile(key),state)
    fs.rmSync(audioFile(key),{force:true})
    return api(cfg,'transcriptions/'+grant.taskId,{signal,fetchImpl})
  }
  const upload=grant.upload,url=new URL(upload?.url)
  if(upload?.method!=='POST'||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^[-a-z0-9]+\.tos-[-a-z0-9]+\.volces\.com$/.test(url.hostname)||!upload.fields||Object.values(upload.fields).some(v=>typeof v!=='string'))throw Error('Invalid TOS upload grant')
  const file=audioFile(key)
  if(!fs.existsSync(file))throw Error('Unconfirmed upload lost its local transfer file')
  const form=new FormData()
  for(const [name,value] of Object.entries(upload.fields))form.set(name,value)
  form.set('file',await openAsBlob(file,{type:'application/octet-stream'}),'audio.m4a')
  // Speech credentials and Bilibili cookies never accompany a TOS request.
  const response=await fetchImpl(url.href,{method:'POST',body:form,redirect:'error',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(120000)])})
  await response.body?.cancel()
  if(!response.ok)throw Error('Temporary audio upload was not confirmed')
  state.input.uploadId=grant.uploadId;save(speechStateFile(key),state)
  fs.rmSync(file,{force:true})
  return null
}
export async function pollVideoAudio(key,{settings={},signal,fetchImpl,now=Date.now,force=false,waitSeconds=25}={}) {
  const cfg=speechSettings(settings)
  if(!cfg.ready)return {status:'unavailable',reason:cfg.reason}
  const file=speechStateFile(key),state=JSON.parse(fs.readFileSync(file,'utf8'))
  if(state.baseUrl!==cfg.baseUrl||state.input.provider!==cfg.provider)throw Error('Speech task belongs to a different service/provider; restore its configuration')
  if(state.job&&['succeeded','failed'].includes(state.job.status))return transcriptResult(state,key)
  if(!force&&state.lastPollAt&&now()-state.lastPollAt<30000)return transcriptResult(state,key)
  state.lastPollAt=now();save(file,state)
  try {
    const hadJob=!!state.job?.id
    let job=hadJob?await api(cfg,'transcriptions/'+state.job.id+'/wait',{body:{timeoutSeconds:waitSeconds,pollIntervalSeconds:3},signal,fetchImpl}):await ensureUpload(cfg,state,key,{signal,fetchImpl})
    if(!job)job=await api(cfg,'transcriptions',{body:state.input,signal,fetchImpl})
    if(!uuid.test(job.id)||job.provider!==cfg.provider||!['queued','running','submitting','submission_unknown','succeeded','failed'].includes(job.status))throw Error('Invalid speech task response')
    if(state.job?.id&&state.job.id!==job.id)throw Error('Speech task identity changed')
    state.job=job;save(file,state)
    // A bounded wait avoids a model round trip for short jobs. A timeout leaves
    // the same durable job pending; it never triggers another submission.
    if(!['succeeded','failed'].includes(job.status)&&!hadJob) {
      const waited=await api(cfg,'transcriptions/'+job.id+'/wait',{body:{timeoutSeconds:waitSeconds,pollIntervalSeconds:3},signal,fetchImpl})
      if(waited.id!==job.id||waited.provider!==cfg.provider||!['queued','running','submitting','submission_unknown','succeeded','failed'].includes(waited.status))throw Error('Invalid speech wait response')
      state.job=waited;save(file,state)
    }
  } catch(error) {
    if(signal?.aborted)throw error
    // A closed reservation requires explicit recovery, not a new paid identity.
    if(error.status===409&&!state.input.uploadId&&!state.job) {fs.rmSync(audioFile(key),{force:true});return {status:'unavailable',reason:'speech_upload_closed_or_conflicting',speech:transcriptResult(state,key).speech}}
    return {...transcriptResult(state,key),reason:'speech_status_unconfirmed',retry_after_seconds:30}
  }
  return transcriptResult(state,key)
}
export async function transcribeVideoAudio({bvid,cid,headers,jget,settings={},signal,fetchImpl,download=downloadMedia}) {
  const cfg=speechSettings(settings)
  if(!cfg.ready)return {status:'unavailable',reason:cfg.reason}
  const key=digest(['speech-upload-v1',bvid,String(cid),cfg.baseUrl,cfg.provider]),file=speechStateFile(key)
  if(!fs.existsSync(file)) {
    const catalog=await api(cfg,'backends',{signal,fetchImpl})
    const backend=catalog.backends?.find(b=>b.name===cfg.provider)
    if(!backend?.configured||backend.processing!=='cloud'||!backend.capabilities?.timestamps)return {status:'unavailable',reason:'cloud_speech_backend_not_ready'}
    if(!catalog.uploads?.configured)return {status:'unavailable',reason:'speech_audio_upload_not_ready'}
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})
    const audio=audioFile(key)
    if(!fs.existsSync(audio)) {
      const playback=await jget(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&qn=16`)
      if(playback.code!==0)throw Error('Audio playback request failed: '+playback.code)
      const stream=playback.data?.dash?.audio?.filter(a=>!a.codecs||String(a.codecs).startsWith('mp4a')).sort((a,b)=>(a.bandwidth??0)-(b.bandwidth??0))[0]
      if(!stream)return {status:'unavailable',reason:'no_separate_aac_audio_stream'}
      const part=audio+'.'+crypto.randomUUID()+'.partial'
      try {
        await download(stream.baseUrl??stream.base_url,part,{headers,signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(120000)]),maxBytes:Math.min(catalog.uploads.maxBytes??512000000,128*1024*1024)})
        try{fs.linkSync(part,audio)}catch(e){if(e.code!=='EEXIST')throw e}
      } finally {fs.rmSync(part,{force:true})}
    }
    const md5=crypto.createHash('md5'),sha=crypto.createHash('sha256'),info=fs.statSync(audio)
    if(!info.isFile()||info.size<1||info.size>128*1024*1024)throw Error('Invalid audio transfer file')
    for await(const chunk of fs.createReadStream(audio)){md5.update(chunk);sha.update(chunk)}
    const input={format:'m4a',clientRequestId:'whale_'+key,provider:cfg.provider,timestamps:true,punctuation:true,normalizeText:true}
    const uploadRequest={format:'m4a',byteLength:info.size,contentMd5:md5.digest('base64'),clientRequestId:'whale_upload_'+key}
    const tmp=file+'.'+crypto.randomUUID()+'.reserve'
    try{fs.writeFileSync(tmp,JSON.stringify({baseUrl:cfg.baseUrl,input,uploadRequest,resourceId:backend.resourceId??cfg.provider,audioHash:sha.digest('hex')}),{mode:0o600});try{fs.linkSync(tmp,file)}catch(e){if(e.code!=='EEXIST')throw e}}finally{fs.rmSync(tmp,{force:true})}
  }
  return pollVideoAudio(key,{settings,signal,fetchImpl})
}

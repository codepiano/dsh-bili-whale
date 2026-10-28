// Explicit visual supplement: requested timestamps only, no whole-video scene scan.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {apiGet} from './bili-api.mjs'
import {credentialsPath,dshPath} from './paths.mjs'
import {requireFfmpeg} from './ffmpeg.mjs'
import {downloadMedia,fileHash} from './media-files.mjs'
const run=promisify(execFile)
export async function readVideoFrames(store,{read_id,times,reason},{signal,jget=apiGet,download=downloadMedia,execute=run}={}) {
  const read=await store.transaction({state:false},d=>d.reads.get(read_id))
  if(!read?.session_id)throw Error('Frames require a real presented reading receipt')
  const material=store.getObject(read.material.hash).content
  if(!Array.isArray(times)||times.length<1||times.length>6||times.some(t=>!Number.isFinite(t)||t<0||t>=material.duration))throw Error('Request 1–6 timestamps within video duration')
  const cred=JSON.parse(fs.readFileSync(credentialsPath,'utf8'))
  const headers={'user-agent':'Mozilla/5.0',referer:`https://www.bilibili.com/video/${read.bvid}/`,cookie:`SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`}
  const ffmpeg=requireFfmpeg(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-frames-'))
  const scope=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(180000)])
  const images=[]
  try {
    const playback=await jget(`https://api.bilibili.com/x/player/playurl?bvid=${read.bvid}&cid=${read.cid}&fnval=16&qn=32`,headers)
    if(playback.code!==0)throw Error('Frame playback request failed: '+playback.code)
    const videos=playback.data?.dash?.video??[]
    const stream=videos.slice().sort((a,b)=>(a.bandwidth??0)-(b.bandwidth??0))[0]
    const url=stream?.baseUrl??stream?.base_url??playback.data?.durl?.[0]?.url
    if(!url)throw Error('No available video stream')
    const video=path.join(dir,'video.mp4')
    await download(url,video,{headers,signal:scope})
    for(const t of [...new Set(times)]) {
      const file=path.join(dir,`frame-${t}.jpg`)
      await execute(ffmpeg,['-nostdin','-y','-loglevel','error','-ss',String(t),'-i',video,'-frames:v','1','-vf','scale=1280:-2','-q:v','3',file],{signal:scope,timeout:30000,maxBuffer:1024*1024})
      const bytes=fs.readFileSync(file)
      if(!bytes.length||bytes.length>4*1024*1024)throw Error('Invalid frame image size')
      images.push({time:t,hash:await fileHash(file),data:bytes.toString('base64')})
    }
    const artifactDir=dshPath('shots','evidence',read.id,crypto.randomUUID())
    fs.mkdirSync(artifactDir,{recursive:true,mode:0o700})
    const frames=images.map((i,n)=>{const file=path.join(artifactDir,n+'.jpg');fs.writeFileSync(file,Buffer.from(i.data,'base64'),{mode:0o600});return {time:i.time,hash:i.hash,path:file}})
    const evidence={read_id,bvid:read.bvid,cid:read.cid,material_hash:read.material.hash,reason,frames,scope:'requested_frames_acquired_not_whole_video_watched'}
    const object=store.object(evidence)
    await store.event('video.frames_acquired',{...evidence,object},{session_id:read.session_id,decision_id:read.feed?.decision_id??null,trace_id:read.trace_id??null})
    return {type:'bili.video_frames.v1',...evidence,object,images}
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
}


export function frameToolContent({images,...metadata}) {
  return [{type:'text',text:JSON.stringify(metadata)},...images.flatMap(i=>[
    {type:'text',text:'视频时间 '+i.time+' 秒；图片 SHA-256 '+i.hash},
    {type:'image',mimeType:'image/jpeg',data:i.data},
  ])]
}

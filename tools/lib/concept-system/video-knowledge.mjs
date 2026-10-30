import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { hash, redact } from './store.mjs'

export function pendingVideoKnowledge(store,session_id) {
  return store.journal.use(db=>db.prepare("SELECT payload FROM video_reads WHERE json_extract(payload,'$.session_id')=? AND json_extract(payload,'$.reading_complete')=1 ORDER BY rowid DESC").all(session_id).map(r=>JSON.parse(r.payload)).filter(r=>!r.coverage?.truncated&&['subtitles','audio_transcript'].includes(r.kind)&&r.knowledge?.status!=='saved').slice(0,5).map(r=>({read_id:r.id,bvid:r.bvid,title:store.getObject(r.material.hash).content.title,source_ids:r.sources.map(s=>s.id)})))
}
async function runNmem(args,content,signal) {
  const cli=process.env.NMEM_CLI_PATH||(fs.existsSync('/usr/local/bin/nmem')?'/usr/local/bin/nmem':'nmem')
  return new Promise((resolve,reject)=>{
    const child=execFile(cli,['--json',...args],{timeout:30000,maxBuffer:2*1024*1024,signal,windowsHide:true},(error,stdout)=>{
      if(error)return reject(Error('Nowledge Mem unavailable: '+redact(error.message).slice(0,300)))
      try{resolve(JSON.parse(stdout))}catch{reject(Error('Nowledge Mem returned invalid JSON'))}
    })
    child.stdin.on('error',()=>{});child.stdin.end(content??'')
  })
}
const writes=new Map()
export class VideoKnowledge {
  constructor(store,{run=runNmem}={}){this.store=store;this.run=run}
  read(id){const read=this.store.journal.use(db=>{const row=db.prepare('SELECT payload FROM video_reads WHERE id=?').get(id);return row?JSON.parse(row.payload):null});if(!read||!read.reading_complete||read.coverage?.truncated||!['subtitles','audio_transcript'].includes(read.kind))throw Error('Knowledge requires complete, delivered video text');return read}
  memoryId(read){return 'fish-video-'+hash([read.bvid,read.cid,read.kind,read.content_hash]).slice(0,32)}
  async get({read_id},{signal}={}){
    const read=this.read(read_id),memory_id=read.knowledge?.memory_id??this.memoryId(read)
    const raw=await this.run(['memories','show',memory_id],null,signal),memory=raw.memory??raw
    if((memory.id??memory.memory_id)!==memory_id||typeof memory.content!=='string')throw Error('Knowledge readback identity/content missing')
    if(!memory.content.includes(`BV=${read.bvid} CID=${read.cid} material=${read.kind} version=${read.content_hash}`)||read.knowledge?.content_hash&&hash(memory.content)!==read.knowledge.content_hash)throw Error('Knowledge source/version readback mismatch')
    return {read_id,memory_id,memory}
  }
  async save(input,options={}){
    const key=this.store.directory+':'+this.memoryId(this.read(input.read_id)),previous=writes.get(key)??Promise.resolve()
    const task=previous.catch(()=>{}).then(()=>this.saveOne(input,options));writes.set(key,task)
    try{return await task}finally{if(writes.get(key)===task)writes.delete(key)}
  }
  async saveOne(input,{signal}={}){
    const read=this.read(input.read_id),memory_id=this.memoryId(read)
    if(read.knowledge?.status==='saved')return {...await this.get(input,{signal}),reused:true}
    for(const q of input.quotes){const source=read.sources.find(s=>s.id===q.source_id);if(!source||!this.store.getObject(source.object.hash).content.excerpt.includes(q.quote))throw Error('Knowledge quote must be verbatim in this read source')}
    const title=this.store.getObject(read.material.hash).content.title
    const content=redact([`视频：${title}\nhttps://www.bilibili.com/video/${read.bvid}\nBV=${read.bvid} CID=${read.cid} material=${read.kind} version=${read.content_hash}\nread_id=${read.id}\nDSH session=${read.session_id}\n实际阅读时间=${read.read_completed_at}`,
      '内容总结（材料主张，未经独立核验）\n'+input.summary,
      '我的理解与想法（鱼的反思，不代表主人偏好）\n'+(input.thoughts||'本次暂无额外想法'),
      '待查与疑问\n'+(input.questions.join('\n')||'本次未提出新问题'),
      '原文依据\n'+input.quotes.map(q=>`${q.source_id}: ${q.quote}`).join('\n'),
    ].join('\n\n'))
    const content_hash=hash(content)
    if(read.knowledge?.content_hash&&read.knowledge.content_hash!==content_hash)throw Error('Pending knowledge already has a different draft; retry the original draft')
    await this.store.transaction({state:false},(d,emit)=>{const current=d.reads.get(read.id);if(current.knowledge?.content_hash&&current.knowledge.content_hash!==content_hash)throw Error('Knowledge draft conflict');d.reads.put({...current,knowledge:{status:'pending',memory_id,content_hash}});emit('knowledge.write_requested',{read_id:read.id,memory_id,content_hash,request:this.store.object({content})},{session_id:read.session_id})})
    // Stable content identity makes timeout/retry an upsert, never a second memory.
    await this.run(['memories','add','--stdin','--id',memory_id,'--title',`鱼读视频：${title||read.bvid}`,'--source','dsh-bili-whale','--source-app','deepseek-harness','--label','fish-reading'],content,signal)
    const result=await this.get({read_id:read.id},{signal})
    if(result.memory.content!==content)throw Error('Nowledge Mem readback differs from submitted knowledge')
    await this.store.transaction({state:false},(d,emit)=>{const current=d.reads.get(read.id);d.reads.put({...current,knowledge:{status:'saved',memory_id,content_hash,saved_at:new Date(this.store.now()).toISOString()}});emit('knowledge.saved',{read_id:read.id,memory_id,content_hash,source_ids:read.sources.map(s=>s.id)},{session_id:read.session_id})})
    return {...result,reused:false,verified:true}
  }
}

import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {redact} from './store.mjs'
const run=promisify(execFile)
const feed=fileURLToPath(new URL('../../commands/feed.mjs',import.meta.url))
const debrief=fileURLToPath(new URL('../../commands/debrief.mjs',import.meta.url))
// Fixed business operations in the already configured local MCP service. No
// arbitrary executable, file path, environment or platform write is accepted.
export async function runFeed(input,{signal}={}) {
  signal?.throwIfAborted()
  const args=[feed,'--json','--run-id',input.run_id,'--seed',input.seed??input.run_id,
    '--n',String(input.n),'--per',String(input.per),'--pool',String(input.pool),'--source',input.source]
  const {stdout}=await run(process.execPath,args,{signal,timeout:120000,maxBuffer:1024*1024,env:{...process.env,DSH_NODE:process.execPath}})
  return JSON.parse(stdout)
}
export async function readDebrief(input,{signal}={}) {
  signal?.throwIfAborted()
  const {stdout}=await run(process.execPath,[debrief,input.bvid,'--no-frames','--audio',input.audio??'auto',...(input.context?['--context']:[]),'--feed-run-id',input.feed_run_id],
    {signal,timeout:1800000,maxBuffer:1024*1024,env:{...process.env,DSH_NODE:process.execPath}})
  const marker=stdout.match(/BILI_DEBRIEF_RECEIPT:[a-f0-9-]{36}:[a-f0-9]{64}/)?.[0]
  return redact({stdout,receipt_marker:marker??null,scope:'actual_debrief_material_not_watch_completion'})
}

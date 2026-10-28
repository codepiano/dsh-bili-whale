import fs from 'node:fs'
import crypto from 'node:crypto'
import {pipeline} from 'node:stream/promises'
import {Readable,Transform} from 'node:stream'
import {guardedFetch as fetch} from './traffic.mjs'
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

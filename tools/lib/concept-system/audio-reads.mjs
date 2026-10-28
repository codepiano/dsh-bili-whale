import {config} from '../config.mjs'
import {pollVideoAudio} from '../video-audio.mjs'
import {VideoReads} from './video-reads.mjs'
export async function pollAudioRead(store,{read_id},{signal,poll=pollVideoAudio,settings=config().reading?.audio}={}) {
  const reads=new VideoReads(store),read=await reads.get(read_id)
  if(!read)throw Error('Unknown video read')
  if(['acquired','presented','assessed'].includes(read.status)&&read.material)return {status:'acquired',receipt_marker:`BILI_DEBRIEF_RECEIPT:${read.id}:${read.material.hash}`}
  if(read.status==='failed')return {status:'failed',read_id,scope:'no_completed_transcript'}
  if(read.status!=='audio_pending'||!read.speech?.key)throw Error('Read has no pending speech task')
  const transcript=await poll(read.speech.key,{settings,signal})
  if(transcript.status==='pending'||transcript.reason==='speech_credentials_missing')return {status:'pending',read_id,retry_after_seconds:30,reason:transcript.reason,task_id:transcript.speech?.task_id??read.speech.task_id,scope:'remote_task_not_read_completion'}
  if(transcript.status!=='success') {
    await reads.fail(read_id,Error(transcript.reason))
    return {status:'failed',read_id,reason:transcript.reason,scope:'no_completed_transcript'}
  }
  const packet=store.getObject(read.audio_draft.hash).content
  const receipt=await reads.complete(read_id,{...packet,transcript:{...transcript,force:read.options?.audio==='always'},components:{...packet.components,audio:'success'}})
  return {status:'acquired',read_id,receipt_marker:receipt.marker,scope:'transcript_acquired_not_read_completion'}
}

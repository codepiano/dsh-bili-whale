// Storage-only bookkeeping shared by receipt ingestion and the worker. A model
// completing concept extraction is not a claim that the whole video was watched.
export function settleVideoRead(d,emit,read,now) {
  if(read.status!=='presented'&&read.status!=='assessed')return
  const jobs=d.reads.jobs(read.id)
  const assessed=jobs.filter(j=>j.status==='done').length
  const failed=jobs.filter(j=>j.status==='failed').length
  const complete=jobs.length>0&&assessed===jobs.length
  if(assessed===read.parts_assessed&&failed===(read.parts_failed??0)&&complete===(read.status==='assessed'))return
  const next={...read,parts_assessed:assessed,parts_failed:failed,status:complete?'assessed':'presented',...(complete?{assessed_at:new Date(now).toISOString()}:{})}
  d.reads.put(next)
  emit(complete?'video.assessed':'video.assessment_progress',{
    read_id:read.id,bvid:read.bvid,kind:read.kind,parts:jobs.length,assessed,failed,scope:'concept_extraction_not_watch_completion',
  },{session_id:read.session_id,trace_id:read.trace_id??null,decision_id:read.feed?.decision_id??null})
}
export function settleReadsForJob(d,emit,job,now) {
  for(const read of d.reads.forJob(job.id))settleVideoRead(d,emit,read,now)
}

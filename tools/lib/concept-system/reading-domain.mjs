import {hash} from './store.mjs'
import {collectionDomain} from './breadth.mjs'

export function readingDomainRequest(state,read,decision) {
  if(!read?.reading_complete||decision?.exploration?.path!=='discover'||decision.exploration.domain_assessment?.read_id===read.id||['failed','skipped'].includes(decision.exploration.progress?.outcome))return null
  return {status:'reading_domain_required',next_action:'reading_domain_assess',required_arguments:{key:'body-domain:'+read.id,read_id:read.id},read_id:read.id,decision_id:decision.id,source_ids:read.sources.map(s=>s.id).slice(0,20),domain_options:[...new Set(Object.values(state.collections??{}).filter(c=>!c.archived_at&&c.subject===decision.subject).map(c=>collectionDomain(c).name))],instructions:'依据刚才完整读完的正文判断领域，用domain、reason、evidence:[{source_id,quote}]记录；引句必须来自本次正文，不能仅照搬搜索领域。无需把原搜索候选归群，后续关键词可以不同。不确定可记未分类并说明。完成后回exploration_next。若正文实际是验证/登录页，直接exploration_progress：outcome=failed、source_ids、reason，不填写问题进展或领域，不保存Mem。'}
}
export function assessReadingDomain(store,d,emit,input,now) {
  const read=d.state.resource_reads?.[input.read_id]??d.reads.get(input.read_id)
  const decision=d.state.concepts?.decisions?.[read?.feed?.decision_id]
  if(!read?.reading_complete||read.coverage?.truncated||!decision?.exploration?.exposure||!['web_page','subtitles','audio_transcript'].includes(read.kind)||['failed','skipped'].includes(decision.exploration.progress?.outcome))throw Error('Domain assessment requires complete delivered body and a non-failed exploration reading')
  const exposure=decision.exploration.exposure
  if(exposure.read_id!==read.id&&!exposure.supplements?.some(s=>s.read_id===read.id))throw Error('Domain assessment must belong to this actual reading')
  const evidence=input.evidence.map(e=>{
    const spec=read.sources.find(s=>s.id===e.source_id);if(!spec)throw Error('Domain evidence must belong to this reading')
    const source=store.getObject(spec.object.hash).content;if(!source.excerpt.includes(e.quote))throw Error('Domain quote must be verbatim in actual body')
    return {...e,source_hash:hash(source)}
  })
  const previous=decision.exploration.domain_assessment??null,assessment={read_id:read.id,domain:input.domain,evidence,reason:input.reason,at:now,scope:'model_or_caller_judgment_from_delivered_body'}
  read.domain_assessment=assessment
  if(read.kind==='web_page')d.state.resource_reads[read.id]=read;else d.reads.put(read)
  decision.exploration.domain=input.domain;decision.exploration.domain_assessment=assessment
  emit('reading.domain_assessed',{decision_id:decision.id,read_id:read.id,previous,assessment},{session_id:read.session_id,decision_id:decision.id})
  return {read_id:read.id,decision_id:decision.id,domain:input.domain,evidence,reason:input.reason}
}

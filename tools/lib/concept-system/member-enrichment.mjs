import { validateTopicLabel,topicKey } from './topic-labels.mjs'
import { hash } from './store.mjs'
import { schemas } from './schemas.mjs'
const norm=s=>s.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()
export function enrichMember(store,d,emit,input,now){
 const state=d.state.concepts,m=state?.members[input.candidate_id];if(!m)throw Error('Unknown candidate')
 const evidence=input.evidence.map(e=>{
  let source,read=null;
  if(e.read_id){read=d.reads.get(e.read_id);if(!read?.reading_complete||read.coverage.truncated)throw Error('Evidence needs complete delivered reading');const ref=read.sources[e.page-1];if(!ref)throw Error('Unknown evidence page');source=store.getObject(ref.object.hash).content}
  else source=state.sources[e.source_id];
  if(!source||!source.excerpt.includes(e.quote))throw Error('Evidence quote must be verbatim in source');
  source=schemas.concept_propose.shape.source.parse(source);
  if(source.actor==='third_party'&&m.subject!=='fish'||source.actor!=='third_party'&&source.actor!==m.subject)throw Error('Evidence subject mismatch');
  if(state.sources[source.id]&&hash(state.sources[source.id])!==hash(source))throw Error('Source identity conflict');
  const metadata=read?store.getObject(read.material.hash).content:null,title=metadata?.title??'';
  return {source,support:source.excerpt+'\n'+title+'\n'+(metadata?.description??''),record:{source_id:source.id,quote:e.quote,source_hash:hash(source),...(read?{read_id:read.id,page:e.page,title,material_hash:read.material.hash}:{}),reason:input.reason}}
 });
 for(const term of input.keywords)if(!evidence.some(e=>norm(e.support).includes(norm(term))))throw Error('Keyword must occur in supplied source evidence');
 const previous_keywords=m.keywords??[];
 const terms=[...new Map([...(input.replace_keywords?[]:previous_keywords),...input.keywords].map(t=>[norm(t),t.trim()])).values()];if(terms.length>20)throw Error('Too many member keywords');
 for(const e of evidence)state.sources[e.source.id]??=e.source;
 const previous_content=m.content;
 if(input.label){validateTopicLabel(input.label);if(!terms.some(t=>norm(t)===norm(input.label)))throw Error('Label must be one of the supported keywords');const duplicate=Object.values(state.members).find(other=>other.id!==m.id&&other.subject===m.subject&&topicKey(other.content)===topicKey(input.label));if(duplicate)throw Error('Existing canonical member '+duplicate.id+'; reuse it instead of duplicating a label');if(input.label!==m.content){m.description??=m.content;m.content=input.label}}
 m.keywords=terms;
 m.evidence=[...new Map([...(m.evidence??[]),...evidence.map(e=>e.record)].map(e=>[hash([e.source_id,e.quote,e.read_id??null,e.page??null]),e])).values()];
 emit('concept.enriched',{candidate_id:m.id,keywords:m.keywords,previous_keywords,previous_content,content:m.content,evidence:m.evidence,reason:input.reason,original_source_id:m.source_id},{trace_id:input.trace_id??null});return m
}

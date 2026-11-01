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
  return {source,record:{source_id:source.id,quote:e.quote,source_hash:hash(source),...(read?{read_id:read.id,page:e.page}:{}),reason:input.reason}}
 });
 for(const term of input.keywords)if(!evidence.some(e=>norm(e.source.excerpt).includes(norm(term))))throw Error('Keyword must occur in supplied source evidence');
 const terms=[...new Map([...(m.keywords??[]),...input.keywords].map(t=>[norm(t),t.trim()])).values()];if(terms.length>20)throw Error('Too many member keywords');
 for(const e of evidence)state.sources[e.source.id]??=e.source;
 m.keywords=terms;
 m.evidence=[...new Map([...(m.evidence??[]),...evidence.map(e=>e.record)].map(e=>[hash([e.source_id,e.quote,e.read_id??null,e.page??null]),e])).values()];
 emit('concept.enriched',{candidate_id:m.id,keywords:m.keywords,evidence:m.evidence,reason:input.reason,original_source_id:m.source_id},{trace_id:input.trace_id??null});return m
}

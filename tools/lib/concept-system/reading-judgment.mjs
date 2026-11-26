// Applies to judged reading slates. Interest generation and archived scoring keep their own policies.
export const QUESTION_FIRST = 'question-first-v1'
export const MAX_STANCE_ADJUSTMENT = 0.04

const normalize = text => (text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

export function readingFocus(route, searchReason) {
  const q = route?.questions?.find(q => q.id === route.target?.question_id)
  const group = route?.revisit?.find(g => g.collection_id === route.target?.collection_id)
  const discovery = route?.path === 'discover' ? route.discovery?.target_domain : null
  return [q?.question, q?.remaining, q?.next_step, group?.name, discovery, searchReason]
    .filter(Boolean).join('\n') || '当前阅读问题'
}

// Each signed judgment must connect an actual condition of this stance to a specific
// assertion in the candidate. Unsubstantiated assessments remain in the archive.
export function readingOption(assessment, stances, material, focus) {
  const candidate = normalize(material)
  const checks = assessment.stances.map(item => {
    const stance = stances.find(s => s.member_id === item.member_id && s.collection_id === item.collection_id)
    const {condition, predicate, focus_quote} = item.evidence ?? {}
    const quote = normalize(item.quote), claim = normalize(predicate), when = normalize(condition)
    const reason = normalize(item.reason)
    let status = 'applicable'
    if (!item.strength) status = 'neutral'
    else if (!when || !stance?.content.includes(condition)) status = 'missing_stance_condition'
    else if (!claim || !material.includes(item.quote) || !item.quote.includes(predicate) ||
      claim.length < 2 || quote.replace(claim, '').length < 2) status = 'missing_candidate_claim'
    else if (!normalize(focus_quote) || !focus.includes(focus_quote) || !reason.includes(normalize(focus_quote))) status = 'missing_question_link'
    else if (!reason.includes(when) || !reason.includes(claim) ||
      !reason.replace(when, '').replace(claim, '').length) status = 'missing_application_reason'
    const start = candidate.indexOf(quote) + quote.indexOf(claim)
    return {item, quote, start, end: start + claim.length, status}
  })
  // Do not assign credit by iteration order when multiple stances claim the same evidence.
  const applicable = checks.filter(c => c.status === 'applicable')
  for (const c of applicable) {
    const overlap = applicable.some(other => other !== c &&
      (other.quote.includes(c.quote) || c.quote.includes(other.quote) ||
        (other.start < c.end && c.start < other.end)))
    if (overlap) c.status = 'shared_candidate_evidence'
  }
  return {
    question_relevance: assessment.exploration.relevance,
    stance_evidence: checks.map(({item,status}) => ({member_id:item.member_id, status})),
    contributions: checks.filter(c => c.status === 'applicable').map(({item}) => ({
      ...item, purpose:'stance', relevance:1,
    })),
  }
}

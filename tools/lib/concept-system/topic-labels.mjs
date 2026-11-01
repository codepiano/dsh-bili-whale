export const topicKey=value=>String(value).normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()
export function validateTopicLabel(content){
 if([...content].length>40||/[\n\r。！？；;：:，,]/u.test(content))throw Error('Topic content must be a short noun/name (1-40 characters), not an explanation; put explanations in description and search terms in keywords')
}

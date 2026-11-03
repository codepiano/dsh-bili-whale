import {resourceUrl} from '../tools/lib/concept-system/web-exploration.mjs'
export const FISH_FETCH_PROVIDER='deepseek-fetch-api'
// Resolve this exact registered provider inside the initiating agent context.
// Never use ctx.web.fetch(), whose provider is a global user preference.
export function registerFishFetch({tools,web,acceptSession}) {
  if(typeof tools?.register!=='function')return
  return tools.register({
    name:'fish_web_fetch',
    description:'鱼可选的独立 DS Fetch API 工具，使用 deepseek-fetch-api。也可自主选择原生web_fetch或fish_gateway_fetch的其它后端。只返回抓取回执；正文归档后按 exploration_next 的 resource_read_page 逐页完整阅读。',
    parameters:{type:'object',required:['url'],properties:{url:{type:'string'}},additionalProperties:false},
    output:{schema:{type:'object',required:['provider','url','statusCode','body','truncated'],additionalProperties:false,properties:{provider:{type:'string'},provider_attempted:{type:'boolean'},url:{type:'string'},statusCode:{type:'integer'},body:{type:'object',required:['kind','content'],properties:{kind:{type:'string'},content:{type:'string'}},additionalProperties:false},truncated:{type:'boolean'},error_code:{type:'string'},api_status:{type:'integer'}}},
      render:(_args,v)=>[{type:'text',text:JSON.stringify({provider:v.provider,provider_attempted:v.provider_attempted,url:v.url,status:v.error_code?'failed':'acquired',api_status:v.api_status,characters:v.body.content.length,truncated:v.truncated,...(v.error_code?{error_code:v.error_code}:{}),next:'自主决定下一步：有正文回exploration_next逐页读；失败可改用web_fetch或fish_gateway_fetch重试同URL，再续步；回执不算阅读。'})}],
      presentationMeta:(_args,v)=>({provider:v.provider,url:v.url,statusCode:v.statusCode,truncated:v.truncated})},
    timeoutMs:90000,isConcurrencySafe:()=>true,
    async execute(input,exec) {
      if(!acceptSession(exec.agent?.session?.id))throw Error('This fetch tool is restricted to the fish session')
      if(Object.keys(input).some(k=>k!=='url')||typeof input.url!=='string'||input.url.length>8192)throw Error('Supply a public URL only')
      const url=resourceUrl(input.url),base={provider:FISH_FETCH_PROVIDER,provider_attempted:false,url,statusCode:0,body:{kind:'text',content:''},truncated:false}
      exec.signal?.throwIfAborted()
      const provider=web?.fetchProviders?.get(FISH_FETCH_PROVIDER)
      if(!provider?.available())return {...base,error_code:'DS_FETCH_UNAVAILABLE'}
      base.provider_attempted=true
      try {
        const value=await provider.fetch({url},exec.signal)
        exec.signal?.throwIfAborted()
        if(typeof value.body?.content!=='string'||!value.body.content.trim())return {...base,api_status:200,error_code:'EMPTY_CONTENT'}
        if(value.url!==url||value.body.kind!=='text'||value.truncated)return {...base,api_status:200,error_code:'INVALID_DS_FETCH_RESULT',truncated:!!value.truncated}
        if(new TextEncoder().encode(value.body.content).length>2000000)return {...base,api_status:200,error_code:'BODY_TOO_LARGE',truncated:true}
        return {...base,statusCode:200,api_status:200,body:{kind:'text',content:value.body.content}}
      } catch(error) {
        exec.signal?.throwIfAborted()
        const status=/HTTP (\d{3})/.exec(String(error.message))?.[1]
        return {...base,...(status?{api_status:Number(status)}:{}),error_code:typeof error.code==='string'&&/^[A-Z_0-9]{1,100}$/.test(error.code)?error.code:'DS_FETCH_FAILED'}
      }
    },
  })
}

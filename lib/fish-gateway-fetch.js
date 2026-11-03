import {resourceUrl} from '../tools/lib/concept-system/web-exploration.mjs'
import {webFetchGateway} from './web-fetch-gateway.js'
export function registerFishGatewayFetch({tools,web,acceptSession,invoke=webFetchGateway}) {
  if(typeof tools?.register!=='function')return
  const allowed=exec=>{if(!acceptSession(exec.agent?.session?.id))throw Error('This tool is restricted to the fish session')}
  const disposeFetch=tools.register({
    name:'fish_gateway_fetch',description:'鱼自主选择 common-mcp Web Fetch 后端：jina、opencli（需安装/登录，仅知乎）或deepseek。参数必须明确选backend；不自动回退。精简回执不算正文，沿exploration_next逐页读取归档。可与原生web_fetch和fish_web_fetch自由选择。',
    parameters:{type:'object',required:['url','backend'],additionalProperties:false,properties:{url:{type:'string'},backend:{type:'string',enum:['jina','opencli','deepseek']}}},
    output:{schema:{type:'object',required:['provider','url','statusCode','body','truncated'],additionalProperties:false,properties:{provider:{type:'string'},provider_attempted:{type:'boolean'},backend:{type:'string'},url:{type:'string'},statusCode:{type:'integer'},body:{type:'object',required:['kind','content'],additionalProperties:false,properties:{kind:{type:'string'},content:{type:'string'}}},truncated:{type:'boolean'},warnings:{type:'array',items:{type:'string'}},sourceCompleteness:{type:'string'},api_status:{type:'integer'},gateway_status:{type:'integer'},error_code:{type:'string'}}},
      render:(_a,v)=>[{type:'text',text:JSON.stringify({provider:v.provider,provider_attempted:v.provider_attempted,url:v.url,status:v.error_code?'failed':'acquired',characters:v.body.content.length,truncated:v.truncated,warnings:v.warnings,sourceCompleteness:v.sourceCompleteness,...(v.error_code?{error_code:v.error_code,api_status:v.api_status}:{}),next:'自主决定下一步：已有正文回exploration_next逐页读；失败可换工具/后端重试同URL，再续步；不重试则继续状态机。'})}],
      presentationMeta:(_a,v)=>({provider:v.provider,url:v.url,statusCode:v.statusCode,truncated:v.truncated})},
    timeoutMs:90000,isConcurrencySafe:()=>true,
    async execute(input,exec){
      allowed(exec)
      if(!['jina','opencli','deepseek'].includes(input.backend)||Object.keys(input).some(k=>!['url','backend'].includes(k)))throw Error('Choose jina, opencli or deepseek and supply URL only')
      const url=resourceUrl(input.url),base={provider:'common-mcp:'+input.backend,backend:input.backend,provider_attempted:false,url,statusCode:0,body:{kind:'text',content:''},truncated:false}
      try{const value=await invoke('read_url',{url,backend:input.backend,maxChars:100000},exec.signal);if(typeof value?.content!=='string'||value.backend!==input.backend)throw Object.assign(Error('Invalid backend response'),{code:'GATEWAY_INVALID_RESPONSE'});return {...base,provider_attempted:true,statusCode:200,body:{kind:'text',content:value.content},truncated:value.truncated===true,warnings:(value.warnings??[]).filter(x=>typeof x==='string').slice(0,10),sourceCompleteness:String(value.sourceCompleteness??'unverified')}}
      catch(error){exec.signal?.throwIfAborted();const {provider_attempted,...failed}=base;return {...failed,error_code:['GATEWAY_UNAVAILABLE','GATEWAY_INVALID_RESPONSE','GATEWAY_REQUEST_FAILED'].includes(error.code)?error.code:'GATEWAY_REQUEST_FAILED',...(Number.isInteger(error.api_status)?{api_status:error.api_status}:{}),...(Number.isInteger(error.gateway_status)?{gateway_status:error.gateway_status}:{})}}
    },
  })
  const disposeBackends=tools.register({
    name:'fish_fetch_backends',description:'列出鱼可自主选择的正文工具与当前配置：DSH原生web_fetch、DS Fetch API、common-mcp Web Fetch 的jina/opencli/deepseek。配置状态不代表目标可读取；不会安装、登录或自动切换后端。',
    parameters:{type:'object',properties:{},additionalProperties:false},
    output:{schema:{type:'object',required:['choices'],properties:{choices:{type:'array',items:{type:'object'}}},additionalProperties:false},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
    timeoutMs:15000,isConcurrencySafe:()=>true,
    async execute(_input,exec){allowed(exec);const choices=[{tool:'web_fetch',provider:'dsh-native',configured:true},{tool:'fish_web_fetch',provider:'deepseek-fetch-api',configured:web?.fetchProviders?.get('deepseek-fetch-api')?.available()===true}];try{const value=await invoke('backends',{},exec.signal);for(const b of value.backends??[])choices.push({tool:'fish_gateway_fetch',backend:b.name,provider:'common-mcp:'+b.name,configured:b.configured,ready:b.ready,requires:b.requires})}catch{choices.push({tool:'fish_gateway_fetch',configured:false,reason:'gateway_unavailable'})}return {choices}},
  })
  return ()=>{disposeFetch?.();disposeBackends?.()}
}

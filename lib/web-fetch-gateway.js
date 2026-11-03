import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {parseEnv} from 'node:util'
// A fixed local business API. Model arguments never contain tokens, paths,
// arbitrary gateway URLs, commands, environment variables or headers.
export async function webFetchGateway(command,args={},signal,{envFile=process.env.COMMON_MCP_ENV_FILE||path.join(os.homedir(),'Documents/ChatGPT/common-mcp/.runtime/http.env'),fetchImpl=fetch}={}) {
  let env
  try{env=parseEnv(await fs.readFile(envFile,'utf8'))}catch{throw Object.assign(Error('Common Web Fetch gateway configuration unavailable'),{code:'GATEWAY_UNAVAILABLE'})}
  const port=Number(env.PORT??4319),token=env.GATEWAY_TOKEN
  if(!Number.isInteger(port)||port<1||port>65535||!token)throw Object.assign(Error('Common Web Fetch gateway is not configured'),{code:'GATEWAY_UNAVAILABLE'})
  if(!['backends','read_url'].includes(command))throw Error('Unsupported Web Fetch command')
  let response
  try{response=await fetchImpl(`http://127.0.0.1:${port}/api/services/web_fetch/commands/${command}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({arguments:args}),signal,redirect:'error'})}
  catch{signal?.throwIfAborted();throw Object.assign(Error('Common Web Fetch gateway unavailable'),{code:'GATEWAY_UNAVAILABLE'})}
  let result
  try{result=await response.json()}catch{throw Object.assign(Error('Invalid gateway response'),{code:'GATEWAY_INVALID_RESPONSE'})}
  if(!response.ok||result.error||result.data?.error)throw Object.assign(Error('Common Web Fetch request failed'),{code:'GATEWAY_REQUEST_FAILED',gateway_status:response.status,api_status:result.error?.upstreamStatus??response.status})
  return result.data
}

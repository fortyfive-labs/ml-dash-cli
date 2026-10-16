import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { ParsedArgs } from '../cli/parser.js';
import { arg, context, endpoint, identity, invalidResponse, ManagementError, record, request, text } from './client.js';

/** Native device login reuses DreamLake's existing materialized auth slots. Scoped sessions never touch disk. */
export async function login(a: ParsedArgs): Promise<unknown> {
  const c = context(a,false);
  const authUrl = endpoint(arg(a,'auth_url') || 'https://auth.vuer.ai');
  const hash = createHash('sha256').update(randomBytes(32).toString('hex'),'utf8').digest('hex');
  const auth = { ...c,url:authUrl,token:undefined };
  const flow = record(await request(auth,'/api/device/start','POST',{client_id:'dreamlake-app',scope:'openid profile email',device_secret_hash:hash}));
  const verification = new URL(text(flow.verification_uri));
  if (verification.protocol !== 'https:' && !['127.0.0.1','localhost'].includes(verification.hostname)) throw invalidResponse();
  process.stderr.write(`Authorize this login at ${verification.origin}${verification.pathname}\nCode: ${text(flow.user_code)}\n`);
  const interval = typeof flow.interval === 'number' ? Math.max(1,Math.min(flow.interval,30)) : 5;
  const until = Date.now()+Math.min(Number(flow.expires_in)||600,600)*1000;
  let access: string | undefined;
  while (Date.now()<until) {
    // Poll replies use OAuth's HTTP400 pending envelope, not the management error contract.
    let response: Response;
    try { response = await fetch(`${authUrl}/api/device/poll`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body:JSON.stringify({client_id:'dreamlake-app',device_secret_hash:hash})}); }
    catch { throw new ManagementError('MANAGED_AUTH_NETWORK','Device authorization could not be completed.','Retry login; no credential was saved.',true); }
    const result = record(await response.json());
    if (response.ok) { access = text(result.access_token); break; }
    if (!['authorization_pending','slow_down'].includes(result.error)) throw new ManagementError('MANAGED_AUTH_DENIED','Device authorization was denied or expired.','Run auth login again.');
    await new Promise(resolve=>setTimeout(resolve,interval*1000));
  }
  if (!access) throw new ManagementError('MANAGED_AUTH_EXPIRED','Device authorization expired.','Run auth login again.');
  const exchanged = record(await request({...c,token:access},'/auth/exchange','POST'));
  const token = text(exchanged.dreamlake_token);
  identity(await request({...c,token},'/auth/me'));
  mkdirSync(c.dir,{recursive:true,mode:0o700});
  // Credentials are written only after exchange and live validation; never returned.
  let previous: Record<string,unknown> = {};
  try { previous=record(JSON.parse(readFileSync(path.join(c.dir,'config.json'),'utf8'))); } catch { /* No prior config. */ }
  for (const [name,value] of [['tokens.json',{'dreamlake-token':token}],['config.json',{...previous,remote_url:c.url}]] as const) {
    const file=path.join(c.dir,name); const temp=`${file}.${process.pid}.tmp`;
    writeFileSync(temp,JSON.stringify(value)+'\n',{mode:0o600}); chmodSync(temp,0o600); renameSync(temp,file);
  }
  access='';
  return {authenticated:true,server:c.url,credentialSource:'DreamLake shared login',scopedCredentialsPersisted:false};
}

/** Advanced standalone login has a separate client ID, token exchange and store. */
export async function standaloneLogin(a: ParsedArgs): Promise<unknown> {
  const { Config }=await import('../config.js');const { TokenStore }=await import('../auth/token-storage.js');const { DeviceFlowClient }=await import('../auth/device-flow.js');
  const config=new Config();const url=endpoint(arg(a,'dash_url')||config.remoteUrl);const authUrl=endpoint(arg(a,'auth_url')||config.authUrl||'https://auth.vuer.ai');
  const flowClient=new DeviceFlowClient(randomBytes(32).toString('hex'),url,authUrl);const flow=await flowClient.startDeviceFlow();
  const verify=new URL(flow.verificationUri);if(verify.origin!==new URL(authUrl).origin)throw invalidResponse();
  process.stderr.write(`Authorize standalone Dash login at ${verify.origin}${verify.pathname}\nCode: ${flow.userCode}\n`);
  let vuer=await flowClient.pollForToken();const exchanged=record(await request({url,token:vuer,dir:config.configDir},'/api/auth/exchange','POST'));const token=text(exchanged.ml_dash_token);
  const me=record(await request({url,token,dir:config.configDir},'/graphql','POST',{query:'query CliStandaloneLogin { me { id username } }',variables:{}}));
  if(me.errors||!me.data?.me)throw invalidResponse();
  new TokenStore(config.configDir).store(token);config.set('remote_url',url);config.set('auth_url',authUrl);vuer='';
  return{authenticated:true,authority:'standalone-dash',server:url,credentialSource:'Standalone Dash login',scopedCredentialsPersisted:false};
}

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ParsedArgs } from '../cli/parser.js';
import { arg, context, invalidResponse, ManagementError, record, request, required } from './client.js';

const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function read(file:string){try{return record(JSON.parse(readFileSync(file,'utf8')));}catch{throw new ManagementError('MANAGED_INVALID_REVIEW','Invalid workspace review file.','Save and review a fresh workspaces plan.');}}
export async function connectionCommand(name:string,action:string,c:ReturnType<typeof context>,a:ParsedArgs){
 const base=`/integrations/dash/ns/${encodeURIComponent(required(a,'namespace'))}`;
 if(name==='connections')return request(c,`${base}/connections`);
 const current=record(await request(c,`${base}/binding`));
 if(action==='status')return current;
 if(!Number.isSafeInteger(current.revision)||current.revision<0)throw invalidResponse();
 const alias=arg(a,'connection')||'default';
 const available=action==='detach'?undefined:record(await request(c,`${base}/workspaces?connectionAlias=${encodeURIComponent(alias)}`));
 if(action==='list')return available;
 let target:null|{instanceId:string,namespaceId:string,connectionAlias:string}=null;
 if(action!=='detach'){
  if(!available||!Array.isArray(available.workspaces)||typeof available.instanceId!=='string')throw invalidResponse();
  const selected=required(a,'remote_namespace');const found=available.workspaces.filter((w:any)=>w.namespaceId===selected||w.slug===selected);
  if(found.length!==1)throw new ManagementError('MANAGED_WORKSPACE_SELECTION','The workspace was not uniquely present in the verified list.','Select a stable remote namespace ID from workspaces list; names do not imply a binding.');
  target={instanceId:available.instanceId,namespaceId:found[0].namespaceId,connectionAlias:alias};
 }
 const review={kind:'external-workspace-review-v1',namespace:required(a,'namespace'),action:action==='detach'?'detach':'connect',expectedRevision:current.revision,current:current.binding?Object.fromEntries(['_id','revision','enabled','instanceId','namespaceId','connectionAlias','mode'].filter(k=>current.binding[k]!==undefined).map(k=>[k,current.binding[k]])):null,target,remoteDataRetained:true};
 if(!a.apply){const file=arg(a,'out');if(file)writeFileSync(file,JSON.stringify(review,null,2)+'\n',{mode:0o600,flag:'wx'});return{status:'preview',review};}
 const prior=read(required(a,'review'));if(digest(prior)!==digest(review))throw new ManagementError('MANAGED_REVIEW_CHANGED','The external target or current binding changed.','Review a fresh exact workspace plan.');
 if(target&&required(a,'remote_namespace')!==target.namespaceId)throw new ManagementError('MANAGED_STABLE_ID_REQUIRED','Apply requires the reviewed stable remote namespace ID.','Use target.namespaceId from the saved review.');
 const result=record(await request(c,`${base}/binding${target?'':`?expectedRevision=${current.revision}`}`,target?'PUT':'DELETE',target?{...target,expectedRevision:current.revision}:undefined));
 if(!Number.isSafeInteger(result.revision)||!('binding'in result)||target&&(!result.binding?.enabled||result.binding.namespaceId!==target.namespaceId||result.binding.instanceId!==target.instanceId))throw invalidResponse();
 return{status:target?'connected':'detached',...result,remoteDataRetained:true};
}

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ParsedArgs } from '../cli/parser.js';
import { arg, context, query, invalidResponse, ManagementError, record, request, required } from './client.js';

const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function read(file:string){try{return record(JSON.parse(readFileSync(file,'utf8')));}catch{throw new ManagementError('MANAGED_INVALID_REVIEW','Invalid workspace review file.','Save and review a fresh workspaces plan.');}}
function page(value:unknown,key:'connections'|'workspaces') {
 const v=record(value);
 if(!Array.isArray(v[key])||v[key].length>100||typeof v.hasMore!=='boolean'||(v.hasMore?(typeof v.nextCursor!=='string'||!v.nextCursor||v.nextCursor.length>4096):v.nextCursor!==null))throw invalidResponse();
 if(key==='workspaces'&&(typeof v.instanceId!=='string'||!v.instanceId))throw invalidResponse();
 const ids=new Set<string>();
 for(const row of v[key]){const id=key==='workspaces'?row?.namespaceId:row?.alias;if(typeof id!=='string'||!id||ids.has(id)||(key==='workspaces'?(typeof row.slug!=='string'||!row.slug):(row.mode!=='external'||typeof row.instanceId!=='string'||!row.instanceId)))throw invalidResponse();ids.add(id);}
 return v;
}
function pageQuery(a:ParsedArgs) {
 if(arg(a,'offset')!==undefined)throw new ManagementError('MANAGED_PAGING_KIND','External discovery uses opaque server cursors.','Use --cursor from nextCursor; do not use --offset.');
 const limit=arg(a,'limit')??'100';
 if(!/^[1-9]\d*$/.test(limit)||Number(limit)>100)throw new ManagementError('MANAGED_INVALID_LIMIT','External discovery page size must be 1–100.','Choose a bounded page size.');
 return query({...a,limit});
}
async function allWorkspaces(c:ReturnType<typeof context>,base:string,alias:string,a:ParsedArgs) {
 if(arg(a,'cursor')!==undefined)throw new ManagementError('MANAGED_PAGING_KIND','Exact workspace selection must inspect the complete inventory.','Omit --cursor for plan/apply; the CLI follows every bounded server page.');
 const rows:any[]=[],cursors=new Set<string>(),ids=new Set<string>();let cursor:string|undefined,instanceId:string|undefined;
 for(let n=0;n<100;n++) {
  const result=page(await request(c,`${base}/workspaces${pageQuery({...a,...(cursor?{cursor}:{})})}&connectionAlias=${encodeURIComponent(alias)}`),'workspaces');
  if(typeof result.instanceId!=='string'||!result.instanceId||instanceId&&instanceId!==result.instanceId)throw invalidResponse();
  instanceId=result.instanceId;
  for(const row of result.workspaces) {
   if(!row||typeof row.namespaceId!=='string'||!row.namespaceId||typeof row.slug!=='string'||!row.slug||ids.has(row.namespaceId))throw invalidResponse();
   ids.add(row.namespaceId);rows.push(row);
  }
  if(!result.hasMore)return{instanceId,workspaces:rows};
  if(cursors.has(result.nextCursor))throw new ManagementError('MANAGED_CURSOR_LOOP','The external service repeated a cursor.','Resolve server pagination before selecting a workspace.');
  cursors.add(result.nextCursor);cursor=result.nextCursor;
 }
 throw new ManagementError('MANAGED_PAGE_LIMIT','External workspace selection exceeded 100 server pages.','Narrow the eligible workspace inventory before binding.');
}
export async function connectionCommand(name:string,action:string,c:ReturnType<typeof context>,a:ParsedArgs){
 const base=`/integrations/dash/ns/${encodeURIComponent(required(a,'namespace'))}`;
 if(name==='connections')return page(await request(c,`${base}/connections${pageQuery(a)}`),'connections');
 const alias=arg(a,'connection')||'default';
 if(action==='list')return page(await request(c,`${base}/workspaces${pageQuery(a)}&connectionAlias=${encodeURIComponent(alias)}`),'workspaces');
 const current=record(await request(c,`${base}/binding`));
 if(action==='status')return current;
 if(!Number.isSafeInteger(current.revision)||current.revision<0)throw invalidResponse();
 const available=action==='detach'?undefined:await allWorkspaces(c,base,alias,a);
 let target:null|{instanceId:string,namespaceId:string,connectionAlias:string}=null;
 if(action!=='detach'){
  if(!available)throw invalidResponse();
  const selected=required(a,'remote_namespace');const found=available.workspaces.filter((w:any)=>w.namespaceId===selected||w.slug===selected);
  if(found.length!==1)throw new ManagementError('MANAGED_WORKSPACE_SELECTION','The workspace was not uniquely present in the complete verified inventory.','Select a stable remote namespace ID from workspaces list; names do not imply a binding.');
  target={instanceId:available.instanceId!,namespaceId:found[0].namespaceId,connectionAlias:alias};
 }
 const review={kind:'external-workspace-review-v1',namespace:required(a,'namespace'),action:action==='detach'?'detach':'connect',expectedRevision:current.revision,current:current.binding?Object.fromEntries(['_id','revision','enabled','instanceId','namespaceId','connectionAlias','mode'].filter(k=>current.binding[k]!==undefined).map(k=>[k,current.binding[k]])):null,target,remoteDataRetained:true};
 if(!a.apply){const file=arg(a,'out');if(file)writeFileSync(file,JSON.stringify(review,null,2)+'\n',{mode:0o600,flag:'wx'});return{status:'preview',review};}
 const prior=read(required(a,'review'));if(digest(prior)!==digest(review))throw new ManagementError('MANAGED_REVIEW_CHANGED','The external target or current binding changed.','Review a fresh exact workspace plan.');
 if(target&&required(a,'remote_namespace')!==target.namespaceId)throw new ManagementError('MANAGED_STABLE_ID_REQUIRED','Apply requires the reviewed stable remote namespace ID.','Use target.namespaceId from the saved review.');
 const result=record(await request(c,`${base}/binding${target?'':`?expectedRevision=${current.revision}`}`,target?'PUT':'DELETE',target?{...target,expectedRevision:current.revision}:undefined));
 if(!Number.isSafeInteger(result.revision)||!('binding'in result)||target&&(!result.binding?.enabled||result.binding.namespaceId!==target.namespaceId||result.binding.instanceId!==target.instanceId))throw invalidResponse();
 return{status:target?'connected':'detached',...result,remoteDataRetained:true};
}

import { existsSync, statSync, readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CommandSpec, ParsedArgs } from '../cli/parser.js';
import { arg, context, identity, invalidResponse, ManagementError, projectRoot, graphql, query, record, request, required, safe, session, text, workload } from './client.js';
import { organizationMutation } from './organizations.js';
import { standaloneCommand, standaloneContext } from './standalone.js';
import { adoptionCommand } from './adoption.js';
import { connectionCommand } from './connections.js';
import { login, standaloneLogin } from './auth.js';

const names = ['auth','instance','orgs','projects','setup','credentials','runs','metrics','logs','files','health','diagnostics','connections','workspaces','adoption','teams'] as const;
const actions: Record<string,string[]> = {
 teams:['list','members'],
 adoption:['inventory','plan','apply','reconcile','recover'],
 connections:['list'],workspaces:['list','status','plan','apply','detach'],
 auth:['status','login'],instance:['show','capabilities'],orgs:['list','create','update','delete','members','teams','member-add','member-role','member-remove'],projects:['list','access'],
 setup:['plan','apply','status','resume'],credentials:['list','inspect','create','rotate','retire'],runs:['list','show','create','status','parameters','delete'],
 metrics:['list','read','append'],logs:['read','append'],files:['list','inspect','upload','download'],health:['check'],diagnostics:['check'],
};
const help: Record<string,string>={teams:'Inspect standalone teams and membership for access diagnostics',adoption:'Inventory and explicitly adopt a legacy project with operator safeguards',connections:'List operator-approved external connections (advanced)',workspaces:'Explicit external workspace discovery, binding and detachment (advanced)',auth:'Shared DreamLake login and live status',instance:'Managed instance identity, version and capabilities',orgs:'Discover organizations and current membership',projects:'Discover projects and inspect effective access',setup:'Review exact resources and resume idempotent setup',credentials:'Inspect or revoke scoped credentials without exporting tokens',runs:'Inspect and create experiment runs',metrics:'Read cursor pages and append metric points',logs:'Read cursor pages and append logs',files:'Inspect and transfer experiment files',health:'Read instance health',diagnostics:'Check identity, capabilities, setup and access'};
export function managementCommand(name: typeof names[number]) {
 const spec: CommandSpec={name,help:help[name],description:`Managed Experiments: ${help[name]}. Existing standalone login/list/upload remain available.`,positionals:[{dest:'action',metavar:'ACTION',help:actions[name].join(' | '),default:actions[name][0]}],options:[
  {flags:['--standalone'],dest:'standalone',boolean:true,help:'Explicitly use standalone Dash identity and APIs, never the DreamLake login'},
  {flags:['--dash-url','--api-url'],dest:'dash_url',help:'Standalone Dash server matching its existing login'},
  {flags:['--offset'],dest:'offset',help:'Standalone list nextOffset (metric/log rows use cursor instead)'},
  {flags:['--team'],dest:'team',help:'Explicit standalone team ID for membership inspection'},
  {flags:['--remote-project'],dest:'remote_project',help:'Explicit legacy Dash project ID for adoption'},
  {flags:['--expected-revision'],dest:'expected_revision',help:'Reviewed authority revision for adoption plan/recovery'},
  {flags:['--plan-hash'],dest:'plan_hash',help:'Exact server adoption plan hash for reconciliation'},
  {flags:['--connection'],dest:'connection',help:'Operator-approved external connection alias; never a URL'},
  {flags:['--remote-namespace'],dest:'remote_namespace',help:'Explicit verified external namespace ID or unique slug for preview'},
  {flags:['--dreamlake-url'],dest:'dreamlake_url',help:'DreamLake server matching the shared login'},
  {flags:['--auth-url'],dest:'auth_url',help:'Vuer device authorization server (auth login only)'},
  {flags:['-n','--namespace'],dest:'namespace',help:'Explicit DreamLake organization slug'},
  {flags:['-p','--project'],dest:'project',help:'Explicit DreamLake project slug or ID'},
  {flags:['--run'],dest:'run',help:'Stable experiment run ID'},
  {flags:['--name'],dest:'name',help:'Explicit organization display name'},
  {flags:['--description'],dest:'description',help:'Explicit organization description'},
  {flags:['--user'],dest:'user',help:'Exact user ID for organization membership operations'},
  {flags:['--role'],dest:'role',choices:['OWNER','MEMBER'],help:'Explicit organization role'},
  {flags:['--run-key'],dest:'run_key',help:'Idempotent run creation key (letters/numbers/_/-)'},
  {flags:['--metric'],dest:'metric',help:'Exact metric name'},
  {flags:['--file'],dest:'file',help:'Stable experiment file ID'},
  {flags:['--input'],dest:'input',help:'Local file to upload (managed limit 8 MiB)'},
  {flags:['--content-type'],dest:'content_type',help:'Upload MIME type (default application/octet-stream)'},
  {flags:['--data'],dest:'data',help:'JSON payload file; - reads stdin (never a credential)'},
  {flags:['--status'],dest:'status',choices:['RUNNING','COMPLETED','FAILED','CANCELLED'],help:'Run lifecycle status'},
  {flags:['--mode'],dest:'mode',choices:['read','write'],help:'Scoped credential mode (default read)'},
  {flags:['--credential'],dest:'credential',help:'Workload credential ID, never its token'},
  {flags:['--expected-generation'],dest:'expected_generation',help:'Reviewed workload credential generation'},
  {flags:['--limit'],dest:'limit',help:'Page size, 1–1000'}, {flags:['--cursor'],dest:'cursor',help:'Opaque next-page cursor'},
  {flags:['--out'],dest:'out',help:'Save a non-secret plan/receipt, or download destination'},
  {flags:['--review'],dest:'review',help:'Previously reviewed plan JSON; required for apply/resume'},
  {flags:['--idempotency-key'],dest:'idempotency_key',help:'Stable intent key for setup apply/resume'},
  {flags:['--apply'],dest:'apply',boolean:true,help:'Execute the exact reviewed change; default is preview'},
  {flags:['--json'],dest:'json',boolean:true,help:'Structured output and stable errors'},
  {flags:['--no-browser'],dest:'no_browser',boolean:true,help:'Login displays the device URL/code without opening a browser'},
 ]};
 return {spec,run:(a:ParsedArgs)=>runManagement(name,a)};
}
export const managementLoaders = Object.fromEntries(names.map(name=>[name,async()=>managementCommand(name)]));
function emit(a: ParsedArgs, data: unknown) {
 const envelope={ok:true,data};
 if(a.json) console.log(JSON.stringify(envelope,null,2));
 else {
  console.log('✓ '+(typeof data==='object'&&data!==null&&'status'in data?String((data as any).status):'Completed'));
  console.log(JSON.stringify(data,null,2));
 }
}
function fail(a:ParsedArgs,e:unknown) {
 const error=e instanceof ManagementError?e:new ManagementError('MANAGED_REQUEST_FAILED','Unable to complete this operation; no change was confirmed.','Inspect status before retrying writes.');
 const result={code:error.code,message:error.message,remediation:error.remediation,retryable:error.retryable};
 if(a.json) console.log(JSON.stringify({ok:false,error:result},null,2)); else console.error(`${result.code}: ${result.message}\n${result.remediation}`);
 return 1;
}
function load(file:string): any { try{return JSON.parse(readFileSync(file==='-'?0:file,'utf8'));}catch{throw new ManagementError('MANAGED_INVALID_INPUT','Input must be valid JSON.','Provide a UTF-8 JSON file or --data - on stdin.');} }
function save(file:string|undefined,data:unknown) {if(file)writeFileSync(file,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});}
function digest(v:unknown){return createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function action(a:ParsedArgs,name:string){const v=arg(a,'action')||actions[name][0];if(!actions[name].includes(v))throw new ManagementError('MANAGED_UNKNOWN_ACTION',`Unknown ${name} action.`,'Use the actions listed in command help.');return v;}
function runPath(a:ParsedArgs){return `/runs/${encodeURIComponent(required(a,'run'))}`;}
function page(value:unknown,key:string):unknown{
 const v=record(value);if(!Array.isArray(v[key]))throw invalidResponse();
 if(v.nextCursor!==undefined&&v.nextCursor!==null&&typeof v.nextCursor!=='string')throw invalidResponse();
 return v;
}
async function findPages(c:ReturnType<typeof context>,a:ParsedArgs,route:string,key:string,match:(v:any)=>boolean) {
 const found:any[]=[];const cursors=new Set<string>();let cursor:string|undefined;
 for(let count=0;count<100;count++) {
  const value=record(page(await request(c,`${route}${query({...a,cursor})}`),key));found.push(...value[key].filter(match));
  if(!value.nextCursor) {if(value.hasMore===true)throw invalidResponse();return found;}
  if(typeof value.nextCursor!=='string'||cursors.has(value.nextCursor))throw new ManagementError('MANAGED_CURSOR_LOOP','The server repeated a pagination cursor.','Retry discovery after the server paging issue is resolved.');
  cursors.add(value.nextCursor);cursor=value.nextCursor;
 }
 throw new ManagementError('MANAGED_PAGE_LIMIT','Exact selection exceeded the bounded 100-page search.','Narrow the target or use a known stable ID and a smaller supported inventory.');
}
/** All changes use a read-only exact intent preview; scoped writer credentials are acquired only after approval. */
async function writeIntent(c:ReturnType<typeof context>,a:ParsedArgs,intent:unknown,perform:()=>Promise<unknown>) {
 const current=record(await request(c,`${projectRoot(a)}/setup`));
 const plan=record(current.plan);
 const preview={kind:'managed-workload-review-v1',namespaceId:text(plan.namespaceId),projectId:text(plan.projectId),instanceId:text(plan.instanceId),intent,credentialIntent:{workloadId:arg(a,'credential')??null,idempotencyKey:arg(a,'idempotency_key')??null},intentHash:digest(intent)};
 if(!a.apply){save(arg(a,'out'),preview);return {status:'preview',review:preview,remediation:'Review these exact resources, then repeat with --apply --review <saved-file>.'};}
 const prior=record(load(required(a,'review')));
 if(JSON.stringify(prior)!==JSON.stringify(preview))throw new ManagementError('MANAGED_REVIEW_CHANGED','The reviewed resources or payload changed.','Create and review a fresh preview; do not automatically approve the change.');
 return perform();
}
export async function runManagement(name:string,a:ParsedArgs):Promise<number>{
 try{
  const act=action(a,name);let c=a.standalone?standaloneContext(a,name!=='auth'||act!=='login'):context(a,name!=='auth'||act!=='login');let result:unknown;
  if(name==='orgs'&&['create','update','delete'].includes(act)){result=await organizationMutation(c,a,act);emit(a,safe(result,[c.token||'']));return 0;}
  if(a.standalone&&!(name==='auth'&&act==='login')){result=await standaloneCommand(name,act,c,a);emit(a,safe(result,[c.token||'']));return 0;}
  if(name==='teams')throw new ManagementError('MANAGED_AUTHORITY_SELECTION','Team inspection requires explicit --standalone in this CLI.','DreamLake project access is inspected using projects access; teams never imply standalone project grants.');
  if(name==='adoption')result=await adoptionCommand(act,c,a);
  else if(name==='connections'||name==='workspaces')result=await connectionCommand(name,act,c,a);
  else if(name==='auth'){
   if(act==='login')result=a.standalone?await standaloneLogin(a):await login(a);
   else {const me=identity(await request(c,'/auth/me'));result={authenticated:true,server:c.url,user:me,credentialSource:'DreamLake shared login'};}
  }else if(name==='instance')result=await request(c,'/managed-experiments/capabilities');
  else if(name==='orgs'){
   if(act==='list')result=page(await request(c,`/managed-experiments/namespaces${query(a)}`),'namespaces');
   else {
    const resolved=await graphql(c,'query ManagedCliOrganization($slug: String!) { organizationBySlug(slug: $slug) { id slug myRole } }',{slug:required(a,'namespace')});
    const org=record(resolved.organizationBySlug);const orgId=text(org.id);
    const members=await graphql(c,'query ManagedCliMembers($orgId: ID!) { organizationMembers(orgId: $orgId) { id userId role } }',{orgId});
    if(!Array.isArray(members.organizationMembers))throw invalidResponse();
    if(act==='members')result={organizationId:orgId,members:members.organizationMembers,pagination:{kind:'unpaginated-server-array',complete:true}};
    else {
     if(org.myRole!=='OWNER')throw new ManagementError('MANAGED_OWNER_REQUIRED','Organization membership changes require current OWNER access.','Ask an organization owner to review this exact membership change.');
     const userId=required(a,'user');const role=act==='member-remove'?undefined:required(a,'role');
     const preview={kind:'organization-membership-review-v1',organizationId:orgId,action:act,userId,...(role?{role}:{}),currentMembersHash:digest(members.organizationMembers),authorityEffect:act==='member-remove'?'Removes organization membership; existing short-lived capabilities may retain their TTL.':'Organization membership grants organization access according to current project policy; no Dash membership is copied.'};
     if(!a.apply){save(arg(a,'out'),preview);result={status:'preview',review:preview};}
     else {const prior=record(load(required(a,'review')));if(digest(prior)!==digest(preview))throw new ManagementError('MANAGED_REVIEW_CHANGED','Organization membership or intent changed.','Refresh and review the exact member change again.');
      const op=act==='member-add'?'organizationMemberAdd':act==='member-role'?'organizationMemberUpdateRole':'organizationMemberRemove';
      const operation=act==='member-remove'?`mutation ManagedCliRemove($orgId: ID!, $userId: ID!) { ${op}(orgId:$orgId,userId:$userId) }`:`mutation ManagedCliMember($orgId: ID!, $userId: ID!, $role: OrgRole!) { ${op}(orgId:$orgId,userId:$userId,role:$role) { id userId role } }`;
      result=await graphql(c,operation,{orgId,userId,...(role?{role}:{})});}
    }
   }
  }else if(name==='projects'){
   const value=page(await request(c,`/managed-experiments/ns/${encodeURIComponent(required(a,'namespace'))}/projects${query(a)}`),'projects') as any;
   if(act==='list')result=value;
   else {const target=required(a,'project');const matches=await findPages(c,a,`/managed-experiments/ns/${encodeURIComponent(required(a,'namespace'))}/projects`,'projects',(p:any)=>p.id===target||p.slug===target);if(matches.length!==1)throw new ManagementError('MANAGED_PROJECT_SELECTION','Project was not uniquely present in this verified page.','Choose a stable project ID from projects list; follow nextCursor if needed.');result=matches[0];}
  }else if(name==='setup'){
   const root=projectRoot(a);const current=record(await request(c,`${root}/${act==='status'?'status':'setup'}`));
   if(act==='plan'){if(!current.plan||typeof current.planHash!=='string'||!Number.isSafeInteger(current.revision))throw invalidResponse();save(arg(a,'out'),safe(current,[c.token||'']));result=current;}
   else if(act==='status')result=current;
   else {
    if(!a.apply)throw new ManagementError('MANAGED_APPROVAL_REQUIRED','Setup apply/resume requires --apply and an exact saved review.','Run setup plan --out <file>, review resources, then supply --review and a stable --idempotency-key.');
    const reviewed=record(load(required(a,'review')));const key=required(a,'idempotency_key');
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(key)||typeof reviewed.planHash!=='string'||!Number.isSafeInteger(reviewed.revision)||!reviewed.plan)throw new ManagementError('MANAGED_INVALID_REVIEW','Invalid setup review or idempotency key.','Use a fresh setup plan and stable intent key.');
    if(act!=='resume' && (digest(reviewed.plan)!==digest(current.plan)||reviewed.planHash!==current.planHash||reviewed.revision!==current.revision))throw new ManagementError('MANAGED_SETUP_CHANGED','Setup resources or revision changed.','Read status; use the existing intent receipt to resolve unknown outcomes, then review a fresh plan if necessary.');
    result=await request(c,`${root}/setup`,'POST',{expectedRevision:reviewed.revision,planHash:reviewed.planHash,idempotencyKey:key});
    const outcome=record(result);const receipt=record(outcome.receipt);if(outcome.status!=='ready'||receipt.projectId!==reviewed.plan.projectId||receipt.namespaceId!==reviewed.plan.namespaceId||receipt.instanceId!==reviewed.plan.instanceId||receipt.idempotencyKey!==key||outcome.revision!==reviewed.revision+1)throw invalidResponse();save(arg(a,'out'),safe(result,[c.token||'']));
   }
  }else if(name==='credentials'){
   const root=projectRoot(a);
   if(act==='list')result=await request(c,`${root}/credentials${query(a)}`);
   else if(act==='inspect')result=await request(c,`${root}/credentials/${encodeURIComponent(required(a,'credential'))}`);
   else {
    const payload:Record<string,unknown>={operation:act,...(arg(a,'run')?{runId:arg(a,'run')}:{})};
    if(act==='create') {const key=required(a,'idempotency_key');if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))throw new ManagementError('MANAGED_INVALID_INTENT','Credential creation requires a stable UUID idempotency key.','Use the same intent UUID across retries.');payload.idempotencyKey=key;}
    if(act!=='create') {payload.credentialId=required(a,'credential'); const generation=required(a,'expected_generation'); if(!/^[1-9]\d*$/.test(generation)||!Number.isSafeInteger(Number(generation)))throw new ManagementError('MANAGED_INVALID_GENERATION','Expected generation must be a positive safe integer.','Inspect the current workload credential metadata.');payload.expectedGeneration=Number(generation);}
    result=await writeIntent(c,a,payload,()=>request(c,`${root}/credentials`,'POST',payload));
   }
  }else if(name==='runs'){
   const root=projectRoot(a);
   if(act==='list')result=page(await request(c,`${root}/runs${query(a)}`),'runs');
   else if(act==='show'){const found=await findPages(c,a,`${root}/runs`,'runs',(r:any)=>r.id===required(a,'run'));if(found.length!==1)throw new ManagementError('MANAGED_RUN_SELECTION','Run ID was not uniquely present in the authorized inventory.','List runs and select its stable ID.');result=found[0];}
   else if(act==='create'){
    const key=required(a,'run_key');if(!/^[A-Za-z0-9_-]{1,128}$/.test(key))throw new ManagementError('MANAGED_INVALID_RUN_KEY','Run key must contain 1–128 letters, numbers, underscores or hyphens.','Choose a stable idempotent run key.');
    result=await writeIntent(c,a,{operation:'run-create',runKey:key},()=>workload(c,a,`/runs/${encodeURIComponent(key)}`,'PUT',{}));
   }else if(act==='delete')result=await writeIntent(c,a,{operation:'run-delete',runId:required(a,'run'),effect:'Soft-delete the experiment record; retain stored metrics, logs and files.'},()=>workload(c,a,runPath(a),'DELETE',{}));
   else if(act==='parameters'&&!arg(a,'data'))result=await request(c,`${root}${runPath(a)}/parameters`);
   else{
    const payload=act==='status'?{status:required(a,'status')}:{data:record(load(required(a,'data')))};
    result=await writeIntent(c,a,{operation:`run-${act}`,runId:required(a,'run'),payloadHash:digest(payload)},()=>workload(c,a,`${runPath(a)}/${act}`,'POST',payload));
   }
  }else if(name==='metrics'){
   const suffix=`${runPath(a)}/metrics`;
   if(act==='list')result=await request(c,`${projectRoot(a)}${suffix}${query(a)}`);
   else if(act==='read')result=await request(c,`${projectRoot(a)}${suffix}/${encodeURIComponent(required(a,'metric'))}${query(a)}`);
   else {const data=load(required(a,'data'));if(!Array.isArray(data)||!data.length||data.length>1000)throw new ManagementError('MANAGED_INVALID_METRICS','Metric data must contain 1–1000 points.','Provide a bounded JSON array.');
    result=await writeIntent(c,a,{operation:'metrics-append',runId:required(a,'run'),metric:required(a,'metric'),payloadHash:digest(data)},()=>workload(c,a,`${suffix}/${encodeURIComponent(required(a,'metric'))}`,'POST',{dataPoints:data}));}
  }else if(name==='logs'){
   if(act==='read')result=await request(c,`${projectRoot(a)}${runPath(a)}/logs${query(a)}`);
   else {const entries=load(required(a,'data'));if(!Array.isArray(entries)||!entries.length||entries.length>1000)throw new ManagementError('MANAGED_INVALID_LOGS','Logs must contain 1–1000 entries.','Provide a bounded JSON array.');result=await writeIntent(c,a,{operation:'logs-append',runId:required(a,'run'),payloadHash:digest(entries)},()=>workload(c,a,`${runPath(a)}/logs`,'POST',{entries}));}
  }else if(name==='files'){
   if(act==='list')result=await request(c,`${projectRoot(a)}${runPath(a)}/files${query(a)}`);
   else if(act==='inspect') {const found=await findPages(c,a,`${projectRoot(a)}${runPath(a)}/files`,'files',(f:any)=>f.id===required(a,'file'));if(found.length!==1)throw new ManagementError('MANAGED_FILE_NOT_IN_PAGE','File is not uniquely present in this page.','Follow nextCursor or inspect a stable file ID from files list.');result=found[0];}
   else if(act==='upload') {
    const input=required(a,'input');let bytes:Buffer;try{const info=statSync(input);if(!info.isFile()||info.size>8*1024*1024)throw new ManagementError('MANAGED_FILE_TOO_LARGE','Managed upload requires a regular file at most 8 MiB.','Choose a supported attachment.');bytes=readFileSync(input);}catch(e){if(e instanceof ManagementError)throw e;throw new ManagementError('MANAGED_FILE_UNREADABLE','Cannot read the selected upload file.','Choose a readable regular file.');}
    if(bytes.length>8*1024*1024)throw new ManagementError('MANAGED_FILE_TOO_LARGE','Managed attachments are limited to 8 MiB.','Use a supported smaller attachment; do not bypass scoped access.');
    const filename=path.basename(input);if(!filename||/[\\/]/.test(filename))throw new ManagementError('MANAGED_INVALID_FILENAME','Attachment filename must be flat.','Choose a file with a simple basename.');
    const contentType=arg(a,'content_type')||'application/octet-stream';const checksum=createHash('sha256').update(bytes).digest('hex');
    result=await writeIntent(c,a,{operation:'file-upload',runId:required(a,'run'),filename,contentType,sizeBytes:bytes.length,checksum},()=>workload(c,a,`${runPath(a)}/files`,'POST',{filename,contentType,dataBase64:bytes.toString('base64')}));
   } else {
    const output=required(a,'out');if(existsSync(output))throw new ManagementError('MANAGED_DESTINATION_EXISTS','Download destination already exists.','Choose a new output path; existing local data was retained.');const value=record(await request(c,`${projectRoot(a)}${runPath(a)}/files/${encodeURIComponent(required(a,'file'))}/download`));
    if(typeof value.dataBase64!=='string'||!Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<0||value.sizeBytes>8*1024*1024||typeof value.checksum!=='string'||!(/^[a-f0-9]{64}$/i.test(value.checksum)))throw invalidResponse();
    const bytes=Buffer.from(value.dataBase64,'base64');if(bytes.length!==value.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==value.checksum.toLowerCase())throw new ManagementError('MANAGED_CHECKSUM_MISMATCH','Attachment bytes failed size or SHA-256 verification.','Retry a read; the destination was not changed.');
    const temp=path.join(path.dirname(output),`.ml-dash-download-${process.pid}-${Date.now()}`);try{writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});/* User chose the output path; remote filename is never used as a path. */linkSync(temp,output);unlinkSync(temp);}catch(e){try{unlinkSync(temp);}catch{}throw e;}
    result={fileId:required(a,'file'),path:output,sizeBytes:bytes.length,checksum:value.checksum,verified:true};
   }
  }else if(name==='health')result={status:'healthy',capabilities:await request(c,'/managed-experiments/capabilities'),authenticated:!!identity(await request(c,'/auth/me'))};
  else {
   const capabilities=await request(c,'/managed-experiments/capabilities');const me=identity(await request(c,'/auth/me'));
   result={status:'healthy',identityValidated:!!me,capabilities,...(arg(a,'namespace')&&arg(a,'project')?{setup:await request(c,`${projectRoot(a)}/status`)}:{})};
  }
  emit(a,safe(result,[c.token||'']));return 0;
 }catch(e){return fail(a,e);}
}

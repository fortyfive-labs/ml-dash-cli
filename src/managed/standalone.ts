import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveContext } from '../cli/context.js';
import { RemoteClient } from '../client.js';
import type { ParsedArgs } from '../cli/parser.js';
import { arg, endpoint, identity, graphql, ManagementError, query, record, request, required, type Context } from './client.js';

/** A separately selected authority. A DreamLake credential is never loaded here. */
export function standaloneContext(a:ParsedArgs,requireLogin=true):Context {
 const old=resolveContext({dash_url:arg(a,'dash_url')});const url=endpoint(old.remoteUrl);
 const configured=endpoint(old.config.remoteUrl);
 const token=url===configured?old.apiKey:undefined;
 if(requireLogin&&!token)throw new ManagementError('STANDALONE_LOGIN_REQUIRED','No standalone Dash login is available for this server.','Run ml-dash login --dash-url for this standalone instance; managed DreamLake tokens are never reused.');
 return{url,token,dir:old.config.configDir};
}
export function offset(a:ParsedArgs){const raw=arg(a,'offset')||'0';if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new ManagementError('MANAGED_INVALID_OFFSET','Offset must be a nonnegative safe integer.','Use the server-returned nextOffset.');return Number(raw);}
export async function standaloneCommand(name:string,action:string,c:Context,a:ParsedArgs):Promise<unknown>{
 const client=new RemoteClient(c.url,arg(a,'namespace'),c.token);const ns=arg(a,'namespace');
 const limit=Number(arg(a,'limit')||50);if(!Number.isInteger(limit)||limit<1||limit>100)throw new ManagementError('MANAGED_INVALID_LIMIT','Standalone inspection page size must be 1–100.','Choose a bounded page size.');
 if(name==='auth')return{authenticated:true,authority:'standalone-dash',server:c.url,user:identity(await client.getCurrentUser())};
 if(name==='health')return{authority:'standalone-dash',...record(await request(c,'/health'))};
 if(name==='instance')return request(c,'/.well-known/dash-experiments');
 if(name==='orgs'){
  if(action==='list')return(await graphql(c,'query CliStandaloneOrgs($limit:Int!,$offset:Int!){ myOrganizationsPaginated(limit:$limit,offset:$offset){ organizations{id slug name myRole} totalCount hasMore nextOffset } }',{limit,offset:offset(a)})).myOrganizationsPaginated;
  const resolved=await graphql(c,'query CliStandaloneOrg($slug:String!){ organizationBySlug(slug:$slug){id slug name myRole} }',{slug:required(a,'namespace')});const org=record(resolved.organizationBySlug);
  if(action==='members')return(await graphql(c,'query CliStandaloneMembers($orgId:ID!,$limit:Int!,$offset:Int!){ organizationMembersPaginated(orgId:$orgId,limit:$limit,offset:$offset){ members{id userId role} totalCount hasMore nextOffset } }',{orgId:org.id,limit,offset:offset(a)})).organizationMembersPaginated;
  if(action==='teams')return(await graphql(c,'query CliStandaloneTeams($orgId:ID!,$limit:Int!,$offset:Int!){ organizationTeamsPaginated(orgId:$orgId,limit:$limit,offset:$offset){ teams{id slug name visibility myRole} totalCount hasMore nextOffset } }',{orgId:org.id,limit,offset:offset(a)})).organizationTeamsPaginated;
  if(org.myRole!=='OWNER')throw new ManagementError('STANDALONE_OWNER_REQUIRED','Standalone organization membership changes require its current owner.','DreamLake ownership does not grant standalone ownership.');
  const members=[];let next=0;
  for(let i=0;i<100;i++){const data=await graphql(c,'query CliStandaloneMembers($orgId:ID!,$limit:Int!,$offset:Int!){organizationMembersPaginated(orgId:$orgId,limit:$limit,offset:$offset){members{id userId role} totalCount hasMore nextOffset}}',{orgId:org.id,limit:100,offset:next});const page=record(data.organizationMembersPaginated);if(!Array.isArray(page.members))throw new ManagementError('STANDALONE_INVALID_RESPONSE','Invalid member inventory.','Check server version.');members.push(...page.members);if(!page.hasMore)break;if(!Number.isSafeInteger(page.nextOffset)||page.nextOffset<=next)throw new ManagementError('STANDALONE_PAGINATION_LOOP','Member inventory did not advance.','Check the server paging contract.');next=page.nextOffset;if(i===99)throw new ManagementError('STANDALONE_PAGE_LIMIT','Member inventory exceeded safe bounds.','Use a bounded organization inventory.');}
  const userId=required(a,'user');const role=action==='member-remove'?undefined:required(a,'role');
  const review={kind:'standalone-organization-membership-review-v1',server:c.url,organizationId:org.id,action,userId,...(role?{role}:{}),membersHash:createHash('sha256').update(JSON.stringify(members)).digest('hex'),effect:'Changes standalone Dash membership only; namespace members can read private projects. No DreamLake grant is implied.'};
  if(!a.apply){if(arg(a,'out'))writeFileSync(arg(a,'out')!,JSON.stringify(review,null,2)+'\n',{mode:0o600,flag:'wx'});return{status:'preview',review};}
  let saved;try{saved=JSON.parse(readFileSync(required(a,'review'),'utf8'));}catch{throw new ManagementError('MANAGED_INVALID_REVIEW','Invalid standalone member review.','Save and review a new exact plan.');}
  if(JSON.stringify(saved)!==JSON.stringify(review))throw new ManagementError('MANAGED_REVIEW_CHANGED','Standalone membership or reviewed intent changed.','Review current standalone authority again.');
  const op=action==='member-add'?'organizationMemberAdd':action==='member-role'?'organizationMemberUpdateRole':'organizationMemberRemove';
  const mutation=action==='member-remove'?`mutation CliStandaloneRemove($orgId:ID!,$userId:ID!){${op}(orgId:$orgId,userId:$userId)}`:`mutation CliStandaloneMember($orgId:ID!,$userId:ID!,$role:OrgRole!){${op}(orgId:$orgId,userId:$userId,role:$role){id userId role}}`;
  return graphql(c,mutation,{orgId:org.id,userId,...(role?{role}:{})});
 }
 if(name==='teams'){
  if(action==='list')return(await graphql(c,'query CliStandaloneMyTeams($limit:Int!,$offset:Int!){myTeamsPaginated(limit:$limit,offset:$offset){teams{id orgId slug name visibility myRole} totalCount hasMore nextOffset}}',{limit,offset:offset(a)})).myTeamsPaginated;
  return(await graphql(c,'query CliStandaloneTeamMembers($teamId:ID!,$limit:Int!,$offset:Int!){teamMembersPaginated(teamId:$teamId,limit:$limit,offset:$offset){members{id userId role} totalCount hasMore nextOffset}}',{teamId:required(a,'team'),limit,offset:offset(a)})).teamMembersPaginated;
 }
 if(name==='projects'){
  if(action==='list')return client.listProjectsGraphql(ns,limit,offset(a));
  return(await graphql(c,'query CliStandaloneProject($namespaceSlug:String,$projectSlug:String!){project(namespaceSlug:$namespaceSlug,projectSlug:$projectSlug){id name slug namespaceId visibility permissions{create update delete}}}',{namespaceSlug:ns??null,projectSlug:required(a,'project')})).project;
 }
 const run=arg(a,'run');const escaped=run?encodeURIComponent(run):'';
 if(name==='runs'){
  if(action==='list')return client.listExperimentsGraphql(required(a,'project'),{namespaceSlug:ns,limit,offset:offset(a)});
  if(action==='show')return(await graphql(c,'query CliStandaloneRun($id:ID!){experimentById(id:$id){id name status description writeProtected project{id namespaceId}}}',{id:required(a,'run')})).experimentById;
 }
 if(name==='metrics'&&action!=='append')return request(c,`/api/experiments/${encodeURIComponent(required(a,'run'))}/metrics${action==='read'?`/${encodeURIComponent(required(a,'metric'))}/rows`:''}${action==='read'?query(a):`?limit=${limit}&offset=${offset(a)}`}`);
 if(name==='logs'&&action==='read')return request(c,`/api/experiments/${encodeURIComponent(required(a,'run'))}/logs${query(a)}`);
 if(name==='files'&&action==='list')return client.listFiles(required(a,'run'),limit,offset(a));
 if(name==='diagnostics')return{authority:'standalone-dash',health:await request(c,'/health'),identity:await client.getCurrentUser(),permissionsPolicy:'Namespace membership controls private project reads; team membership is not a project data ACL. Legacy logout is local-only and does not revoke an ordinary token.'};
 throw new ManagementError('STANDALONE_AUTHORITY_BOUNDARY','This management action belongs to the managed DreamLake control plane.','Remove --standalone for managed setup/credentials, or use the existing standalone create/remove/upload/download commands for legacy data.');
}

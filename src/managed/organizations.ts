import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ParsedArgs } from '../cli/parser.js';
import { arg, graphql, identity, invalidResponse, ManagementError, record, request, required, type Context } from './client.js';

/**
 * What DreamLake's `organizationDelete` does (`services/organizationDeletion.ts`): a logical quarantine
 * in the server's fenced transaction, owner only, refused while work is still running.
 */
const DREAMLAKE_DELETE_EFFECT='Quarantine the organization. Its namespaces and everything they own (projects, Notes, artifacts and other resources) are logically deleted and made private, and their share links are revoked; the records and stored bytes are retained, but the CLI cannot restore them and nothing is physically purged. Sources and connections are disabled, Vault secrets are marked for deletion and their access keys revoked, pending ownership transfers are cancelled, and teams, memberships and project grants are removed. The organization and namespace names stay reserved. The server refuses while runs, workflows, source operations, ownership transfers or managed-credential retirement are still active, and deletes at most 1,000 Notes per attempt.';

/** Typed organization CRUD. Delete relies on the companion server's transactional empty-org soft-delete guard. */
export async function organizationMutation(c:Context,a:ParsedArgs,operation:string){
 const slug=required(a,'namespace');
 // DreamLake's GraphQL has no `me`: its signed-in user comes from /auth/me, as every other DreamLake command reads it.
 const actor=a.standalone?record((await graphql(c,'query CliOrganizationActor { me { id } }',{})).me):identity(await request(c,'/auth/me'));
 let current:any=null;let input:Record<string,string>|undefined;
 if(operation==='create'){
  const available=await graphql(c,'query CliOrganizationAvailable($slug:String!){isOrgSlugAvailable(slug:$slug)}',{slug});
  if(available.isOrgSlugAvailable!==true)throw new ManagementError('ORGANIZATION_SLUG_UNAVAILABLE','This organization slug is already in use.','Inspect the existing organization; do not create a same-name replacement.');
  input={slug,name:required(a,'name'),...(arg(a,'description')?{description:arg(a,'description')!}:{})};
 }else{
  if(operation==='delete'&&a.standalone){
   const capabilities=record(await request(c,'/.well-known/dash-experiments'));
   if(capabilities.organizationDeletion!=='transactional-empty-soft-delete-v1')throw new ManagementError('ORGANIZATION_SAFE_DELETE_UNAVAILABLE','This standalone server has not advertised transactional empty-organization soft deletion.','Upgrade the companion backend; client preflight cannot make legacy hard deletion safe.');
  }
  const found=(await graphql(c,'query CliOrganizationReview($slug:String!){organizationBySlug(slug:$slug){id slug name description myRole}}',{slug})).organizationBySlug;
  if(found===null)throw new ManagementError('NOT_FOUND','Organization not found.','Check the organization slug; a deleted organization is not shown.');
  current=record(found);
  if(current.myRole!=='OWNER')throw new ManagementError('ORGANIZATION_OWNER_REQUIRED','Organization metadata changes require the selected authority\'s OWNER.','Managed DreamLake ownership and standalone Dash ownership are separate.');
  if(operation==='update'){
   input={...(arg(a,'name')?{name:arg(a,'name')!}:{}),...(arg(a,'description')!==undefined?{description:arg(a,'description')!}:{})};
   if(!Object.keys(input).length)throw new ManagementError('MANAGED_ARGUMENT_REQUIRED','Supply --name or --description for an update.','Preview an explicit metadata change.');
  }else if(a.standalone){
   const p=record((await graphql(c,'query CliOrganizationProjects($slug:String!){projectsPaginated(namespaceSlug:$slug,limit:1,offset:0){totalCount}}',{slug})).projectsPaginated);
   if(typeof p.totalCount!=='number'||p.totalCount!==0)throw new ManagementError('ORGANIZATION_NOT_EMPTY','The organization still has projects and cannot be deleted.','Retain its data and resolve project ownership separately.');
  }
 }
 const review={kind:'organization-metadata-review-v1',authority:a.standalone?'standalone-dash':'dreamlake',server:c.url,actorId:actor.id,operation,slug,current,input:input??null,effect:operation==='delete'?(a.standalone?'Soft-delete organization, namespace and teams only if server transaction confirms no projects, including soft-deleted projects. Membership/inventory records are retained.':DREAMLAKE_DELETE_EFFECT):operation==='create'?'Create this explicit organization; the current requester becomes its OWNER.':'Update only the selected metadata fields.'};
 if(!a.apply){if(arg(a,'out'))writeFileSync(arg(a,'out')!,JSON.stringify(review,null,2)+'\n',{mode:0o600,flag:'wx'});return{status:'preview',review};}
 let prior;try{prior=JSON.parse(readFileSync(required(a,'review'),'utf8'));}catch{throw new ManagementError('MANAGED_INVALID_REVIEW','Invalid organization review file.','Save and review a fresh exact preview.');}
 const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 if(hash(prior)!==hash(review))throw new ManagementError('MANAGED_REVIEW_CHANGED','Organization authority, state or intent changed.','Inspect and review current organization state again.');
 const result=operation==='create'?await graphql(c,'mutation CliOrganizationCreate($input:OrganizationCreateInput!){organizationCreate(input:$input){id slug name myRole}}',{input}):operation==='update'?await graphql(c,'mutation CliOrganizationUpdate($id:ID!,$input:OrganizationUpdateInput!){organizationUpdate(id:$id,input:$input){id slug name myRole}}',{id:current.id,input}):await graphql(c,'mutation CliOrganizationDelete($id:ID!){organizationDelete(id:$id)}',{id:current.id});
 if(operation==='delete'?result.organizationDelete!==true:!result[operation==='create'?'organizationCreate':'organizationUpdate']?.id)throw invalidResponse();
 return result;
}

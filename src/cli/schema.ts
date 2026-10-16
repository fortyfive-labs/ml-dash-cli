import type { CommandSpec } from './parser.js';
import { commandLoaders } from './loaders.js';
import { managementActions } from '../managed/commands.js';
import { ManagementError, record, text } from '../managed/client.js';
import { VERSION } from '../version.js';

const dialect = 'https://json-schema.org/draft/2020-12/schema';
export const successEnvelopeSchema = { $schema: dialect, type:'object', required:['ok','data'], additionalProperties:false, properties:{ ok:{const:true}, data:{} } };
export const errorEnvelopeSchema = { $schema: dialect, type:'object', required:['ok','error'], additionalProperties:false, properties:{ok:{const:false},error:{type:'object',required:['code','message','remediation','retryable'],additionalProperties:false,properties:{code:{type:'string',minLength:1},message:{type:'string'},remediation:{type:'string'},retryable:{type:'boolean'}}}} };
function inputs(spec:CommandSpec, action?:string) {
 const properties:Record<string,unknown>={};
 for(const option of spec.options) properties[option.dest]={type:option.boolean?'boolean':'string',...(option.choices?{enum:option.choices}:{}),description:option.help};
 for(const positional of spec.positionals??[]) properties[positional.dest]={type:'string',...(positional.dest==='action'&&managementActions[spec.name]?{enum:managementActions[spec.name],...(action?{const:action}:{})}:{}),description:positional.help,...(positional.default?{default:positional.dest==='action'&&action?action:positional.default}:{})};
 return {$schema:dialect,type:'object',additionalProperties:false,properties,required:spec.options.filter(o=>o.required).map(o=>o.dest)};
}
const requiredInputs:Record<string,string[]>={
 'orgs.members':['namespace'],'orgs.teams':['namespace'],'orgs.create':['namespace','name'],'orgs.update':['namespace'],'orgs.delete':['namespace'],
 'orgs.member-add':['namespace','user','role'],'orgs.member-role':['namespace','user','role'],'orgs.member-remove':['namespace','user'],
 'projects.list':['namespace'],'projects.access':['namespace','project'],
 'connections.list':['namespace'],'workspaces.list':['namespace'],'workspaces.status':['namespace'],'workspaces.plan':['namespace','remote_namespace'],'workspaces.apply':['namespace','remote_namespace'],'workspaces.detach':['namespace'],
};
function operation(spec:CommandSpec, action:string) {
 const id=`${spec.name}.${action}`;
 const input=inputs(spec,action);
 const required=[...(requiredInputs[id]??[])];
 if(['setup','credentials','runs','metrics','logs','files','adoption'].includes(spec.name))required.push('namespace','project');
 if(spec.name==='setup'&&['apply','resume'].includes(action))required.push('apply','review','idempotency_key');
 if(spec.name==='credentials') {
  if(['inspect','rotate','retire'].includes(action))required.push('credential');
  if(['rotate','retire'].includes(action))required.push('expected_generation');
  if(action==='create')required.push('idempotency_key');
 }
 if(spec.name==='runs'&&action==='create')required.push('run_key');
 if(spec.name==='runs'&&['show','status','parameters','delete'].includes(action))required.push('run');
 if(id==='runs.status')required.push('status');
 if(['metrics','logs','files'].includes(spec.name))required.push('run');
 if(spec.name==='metrics'&&['read','append'].includes(action))required.push('metric');
 if(['metrics.append','logs.append'].includes(id))required.push('data');
 if(spec.name==='files'&&['inspect','download'].includes(action))required.push('file');
 if(id==='files.upload')required.push('input');
 if(id==='files.download')required.push('out');
 if(spec.name==='adoption')required.push('remote_project');
 if(['adoption.plan','adoption.recover'].includes(id))required.push('expected_revision');
 if(id==='adoption.reconcile')required.push('plan_hash');
 if(['adoption.apply','adoption.recover'].includes(id))required.push('apply','review','idempotency_key');
 if(spec.name==='teams'){required.push('standalone');if(action==='members')required.push('team');}
 input.required=[...new Set(['action',...input.required,...required])];
 if(required.includes('apply'))input.properties.apply={type:'boolean',const:true};
 if(spec.name==='teams')input.properties.standalone={type:'boolean',const:true};
 return {id,authority:spec.name==='teams'?'standalone-dash-required':'dreamlake-default',input,output:successEnvelopeSchema,error:errorEnvelopeSchema,
  ...( ['setup','credentials','runs','metrics','logs','files','orgs','workspaces','adoption'].includes(spec.name)?{mutationPolicy:{default:'preview-for-write-actions',applyRequires:['apply','review'],writerSession:'in-memory-only',note:'Read actions do not require apply. Run parameters without data is read-only; first writes additionally require a writer credential or UUID idempotency intent. Server authorization is final.'}}:{}),
  ...(id==='orgs.members'||id==='orgs.teams'?{pagination:{kind:'offset',inputs:['limit','offset'],continuation:'nextOffset',serverSide:true}}:{}),
  ...(id==='workspaces.list'||id==='connections.list'?{pagination:{kind:'cursor',inputs:['limit','cursor'],continuation:'nextCursor',serverSide:true}}:{})};
}
/** Built from the actual dispatch table and parser specs, including the legacy surface. */
export async function cliInspectionSchema() {
 const commands=await Promise.all(Object.entries(commandLoaders).map(async([name,load])=>{
  const {spec}=await load();const actions=managementActions[name]??[];
  return {name,description:spec.help,options:spec.options.map(option=>({...option,valueType:option.boolean?'boolean':'string'})),positionals:spec.positionals??[],mutuallyExclusive:spec.mutuallyExclusive??[],input:inputs(spec),
   actions,operations:actions.map(action=>operation(spec,action)),output:actions.length||name==='schema'?{format:'json-envelope',success:successEnvelopeSchema,error:errorEnvelopeSchema}:{format:'legacy-command-specific',note:'Use the command help; legacy output is not the managed JSON envelope.'}};
 }));
 return {schemaVersion:'1',cliVersion:VERSION,supportedManagedApiVersions:['1'],dialect,commands,envelopes:{success:successEnvelopeSchema,error:errorEnvelopeSchema},scope:'CLI grammar and managed JSON envelope; per-operation backend resource schemas are discovered with instance schema.'};
}
export function validateManagedCapabilities(value:unknown) {
 const body=record(value);
 if(body.version!=='1')throw new ManagementError('MANAGED_PROTOCOL_UNSUPPORTED','The service advertises an unsupported managed API version.','Use matching CLI and backend versions; do not interpret unknown protocols.');
 if(typeof body.instanceId!=='string'||!body.instanceId||!Array.isArray(body.capabilities)||body.capabilities.some((v:unknown)=>typeof v!=='string'))throw new ManagementError('MANAGED_INVALID_RESPONSE','Invalid capability discovery response.','Check backend discovery support.');
 return body;
}
export function validateManagedServiceSchema(value:unknown) {
 const body=record(value);
 if(body.schemaVersion!=='1'||body.protocolVersion!=='1')throw new ManagementError('MANAGED_SCHEMA_UNSUPPORTED','The service schema or managed protocol version is unsupported.','Use a matching backend schema; unknown versions are refused.');
 text(body.instanceId);
 if(!Array.isArray(body.operations)||!body.operations.length||body.operations.length>1000)throw new ManagementError('MANAGED_INVALID_RESPONSE','The service returned no bounded operation schemas.','Check matching backend schema support.');
 const ids=new Set<string>();
 for(const item of body.operations) {
  const row=record(item);text(row.id);if(ids.has(row.id)||!['GET','POST','PUT','PATCH','DELETE'].includes(row.method)||typeof row.path!=='string'||!row.path.startsWith('/'))throw new ManagementError('MANAGED_INVALID_RESPONSE','Invalid service operation schema.','Check backend schema support.');
  for(const schema of [row.input,row.output]){const contract=record(schema);if(!['object','array','string','number','integer','boolean','null'].includes(contract.type)&&typeof contract.$ref!=='string'&&!Array.isArray(contract.oneOf)&&!Array.isArray(contract.anyOf))throw new ManagementError('MANAGED_INVALID_RESPONSE','The service returned labels instead of operation schemas.','Check the backend JSON Schema contract.');}
  ids.add(row.id);
 }
 for(const required of ['setup.plan','setup.apply','session.create','runs.list','metrics.rows','organization.members.list','organization.teams.list'])if(!ids.has(required))throw new ManagementError('MANAGED_INVALID_RESPONSE','The service schema omits a required inspection contract.','Upgrade the backend schema together with the CLI.');
 record(record(body.envelopes).success);record(body.envelopes.error);
 return body;
}

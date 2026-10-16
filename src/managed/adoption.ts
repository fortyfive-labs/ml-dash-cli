import { readFileSync, writeFileSync } from 'node:fs';
import type { ParsedArgs } from '../cli/parser.js';
import { arg, context, invalidResponse, ManagementError, projectRoot, record, request, required } from './client.js';

export async function adoptionCommand(action:string,c:ReturnType<typeof context>,a:ParsedArgs){
 const base=`${projectRoot(a)}/adoption/${encodeURIComponent(required(a,'remote_project'))}`;
 if(action==='inventory')return request(c,`${base}/inventory`);
 if(action==='reconcile')return request(c,`${base}/reconcile?planHash=${encodeURIComponent(required(a,'plan_hash'))}`);
 if(action==='plan'){
  const rev=required(a,'expected_revision');if(!/^(0|[1-9]\d*)$/.test(rev)||!Number.isSafeInteger(Number(rev)))throw new ManagementError('MANAGED_INVALID_REVISION','Expected inventory revision must be a nonnegative safe integer.','Inspect adoption inventory and review the current authority revision.');
  const result=record(await request(c,`${base}/plan?expectedRevision=${rev}`));
  if(!result.plan||typeof result.planHash!=='string'||!Number.isSafeInteger(result.revision))throw invalidResponse();
  const out=arg(a,'out');if(out)writeFileSync(out,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
  return result;
 }
 if(!a.apply)throw new ManagementError('MANAGED_APPROVAL_REQUIRED','Adoption apply/recover requires --apply and a reviewed server plan.','Inspect inventory and plan first; adoption replaces authority and requires operator fencing, backup and draining.');
 let review:Record<string,any>;try{review=record(JSON.parse(readFileSync(required(a,'review'),'utf8')));}catch{throw new ManagementError('MANAGED_INVALID_REVIEW','Invalid adoption review.','Save and review the server-generated adoption plan.');}
 const plan=record(review.plan);
 if(plan.operation!=='adopt-existing-project'||typeof review.planHash!=='string'||plan.planHash!==review.planHash||!Number.isSafeInteger(review.revision)||!plan.target||!plan.inventory||plan.inventory.remoteProjectId!==required(a,'remote_project'))throw invalidResponse();
 if(plan.expiresAt!==undefined&&(!Number.isFinite(plan.expiresAt)||plan.expiresAt<=Date.now()))throw new ManagementError('MANAGED_ADOPTION_PLAN_EXPIRED','The reviewed adoption plan expired.','Refresh inventory and review a new plan; do not silently substitute authority.');
 const key=required(a,'idempotency_key');
 const revision=action==='recover'?required(a,'expected_revision'):String(review.revision);
 if(!/^(0|[1-9]\d*)$/.test(revision)||!Number.isSafeInteger(Number(revision)))throw new ManagementError('MANAGED_INVALID_REVISION','Expected authority revision is invalid.','Use the current inventory revision for recovery.');
 return request(c,`${base}/${action}`,'POST',{planHash:review.planHash,expectedRevision:Number(revision),idempotencyKey:key});
}

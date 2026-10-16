import type { ParsedArgs } from '../cli/parser.js';
import { arg, graphql, invalidResponse, ManagementError, record, type Context } from './client.js';

export function organizationPaging(a: ParsedArgs) {
  if (arg(a, 'cursor') !== undefined) throw new ManagementError('MANAGED_PAGING_KIND', 'Organization members and teams use server nextOffset pagination.', 'Pass --offset from nextOffset; opaque --cursor is used only by cursor-based lists.');
  const limit = arg(a, 'limit') ?? '50', offset = arg(a, 'offset') ?? '0';
  if (!/^[1-9]\d*$/.test(limit) || Number(limit) > 100) throw new ManagementError('MANAGED_INVALID_LIMIT', 'Organization page size must be between 1 and 100.', 'Choose a bounded page size.');
  if (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) throw new ManagementError('MANAGED_INVALID_OFFSET', 'Offset must be a nonnegative safe integer.', 'Use the server-returned nextOffset.');
  return { limit: Number(limit), offset: Number(offset) };
}
export async function organizationInspection(c: Context, orgId: string, kind: 'members' | 'teams', paging: { limit: number; offset: number }) {
  const field = kind === 'members' ? 'organizationMembersPaginated' : 'organizationTeamsPaginated';
  const fields = kind === 'members' ? 'id userId role' : 'id slug name visibility';
  const value = record((await graphql(c, `query ManagedCliOrganization${kind === 'members' ? 'Members' : 'Teams'}Page($orgId:ID!,$limit:Int!,$offset:Int!){${field}(orgId:$orgId,limit:$limit,offset:$offset){${kind}{${fields}} totalCount hasMore nextOffset}}`, { orgId, ...paging }))[field]);
  const rows = value[kind];
  if (!Array.isArray(rows) || rows.length > paging.limit || !Number.isSafeInteger(value.totalCount) || value.totalCount < 0 || typeof value.hasMore !== 'boolean' ||
    (value.hasMore ? !rows.length || value.nextOffset !== paging.offset + rows.length || value.nextOffset >= value.totalCount : value.nextOffset !== null)) throw invalidResponse();
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || (kind === 'members' ? typeof row.userId !== 'string' || !row.userId || !['OWNER','MEMBER'].includes(row.role) : typeof row.slug !== 'string' || !row.slug || typeof row.name !== 'string' || !['PUBLIC','PRIVATE'].includes(row.visibility))) throw invalidResponse();
    ids.add(row.id);
  }
  return { organizationId: orgId, [kind]: rows, totalCount: value.totalCount, hasMore: value.hasMore, nextOffset: value.nextOffset, pagination: { kind: 'offset', ...paging } };
}
/** Membership mutations review the complete bounded server inventory, never a page slice. */
export async function allOrganizationMembers(c: Context, orgId: string) {
  const rows: any[] = [], ids = new Set<string>(); let offset = 0, total: number | undefined;
  for (let page = 0; page < 100; page++) {
    const value = await organizationInspection(c, orgId, 'members', { limit: 100, offset });
    if (total !== undefined && total !== value.totalCount) throw invalidResponse();
    total = value.totalCount;
    for (const row of value.members) { if (ids.has(row.id)) throw invalidResponse(); ids.add(row.id); rows.push(row); }
    if (!value.hasMore) { if (rows.length !== total) throw invalidResponse(); return rows; }
    offset = value.nextOffset;
  }
  throw new ManagementError('MANAGED_PAGE_LIMIT', 'Organization inventory exceeded 100 server pages.', 'Narrow the operation or resolve the server inventory size before changing membership.');
}

import { tenantUserStorageKey } from './tenant-storage';

/** Generate a session-filter key only from verified tenant and user identity. */
export function sessionFilterStorageKey(tenantId: string, userId: string): string {
  return tenantUserStorageKey(tenantId, userId, 'session-filter');
}

/** Persist an employee/team scope only under explicit tenant and user identity. */
export function persistSharedAgentScope(
  agentId: string,
  tenantId: string,
  userId: string,
): void {
  if (!agentId) return;
  const key = tenantUserStorageKey(tenantId, userId, 'selected-agent');
  window.localStorage.setItem(key, agentId);
}

/** Clear only the employee/team scope for the explicit tenant and user. */
export function clearSharedAgentScope(tenantId: string, userId: string): void {
  const key = tenantUserStorageKey(tenantId, userId, 'selected-agent');
  window.localStorage.removeItem(key);
}

// Team scopes share the same storage slot as employee agent ids, prefixed so
// readers can tell "current team" apart from "current employee".
export const TEAM_SCOPE_PREFIX = 'team:';

export function toTeamScope(teamId: string): string {
  return teamId ? `${TEAM_SCOPE_PREFIX}${teamId}` : '';
}

export function isTeamScope(value: string | null | undefined): boolean {
  return typeof value === 'string'
    && value.startsWith(TEAM_SCOPE_PREFIX)
    && value.length > TEAM_SCOPE_PREFIX.length;
}

export function teamIdFromScope(value: string | null | undefined): string {
  return isTeamScope(value) ? String(value).slice(TEAM_SCOPE_PREFIX.length) : '';
}

/** Read only the explicit tenant/user scope; team scopes appear empty to employee-only pages. */
export function readEmployeeScope(tenantId: string, userId: string): string {
  try {
    const scopedKey = tenantUserStorageKey(tenantId, userId, 'selected-agent');
    const raw = window.localStorage.getItem(scopedKey) || '';
    return isTeamScope(raw) ? '' : raw;
  } catch {
    return '';
  }
}

export function emitAgentScopeChange(agentId: string): void {
  window.dispatchEvent(
    new CustomEvent('ultrarag-enterprise-agent-scope-change', {
      detail: { agentId },
    }),
  );
}

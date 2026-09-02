// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSharedAgentScope,
  isTeamScope,
  persistSharedAgentScope,
  readEmployeeScope,
  sessionFilterStorageKey,
  teamIdFromScope,
  toTeamScope,
} from './agent-scope-storage';

function safely<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('team agent-scope helpers', () => {
  it('builds a team scope value with the team: prefix', () => {
    expect(toTeamScope('team-1')).toBe('team:team-1');
    expect(toTeamScope('')).toBe('');
  });

  it('detects team scope values and leaves employee ids alone', () => {
    expect(isTeamScope('team:team-1')).toBe(true);
    expect(isTeamScope('agent-1')).toBe(false);
    expect(isTeamScope('team:')).toBe(false);
    expect(isTeamScope('')).toBe(false);
    expect(isTeamScope(null)).toBe(false);
    expect(isTeamScope(undefined)).toBe(false);
  });

  it('extracts the team id from a team scope value', () => {
    expect(teamIdFromScope('team:team-1')).toBe('team-1');
    expect(teamIdFromScope('team:team:with:colons')).toBe('team:with:colons');
    expect(teamIdFromScope('agent-1')).toBe('');
    expect(teamIdFromScope(null)).toBe('');
  });

  it('keeps selected employee scope isolated for tenant and user replacement', () => {
    persistSharedAgentScope('agent-a', 'tenant-a', 'user-a');

    expect(readEmployeeScope('tenant-a', 'user-a')).toBe('agent-a');
    expect(readEmployeeScope('tenant-b', 'user-a')).toBe('');
    expect(readEmployeeScope('tenant-a', 'user-b')).toBe('');

    persistSharedAgentScope('agent-b', 'tenant-b', 'user-a');
    expect(readEmployeeScope('tenant-a', 'user-a')).toBe('agent-a');
    expect(readEmployeeScope('tenant-b', 'user-a')).toBe('agent-b');
  });

  it('keeps selected team scope in the same tenant/user namespace without leaking it', () => {
    persistSharedAgentScope(toTeamScope('team-a'), 'tenant-a', 'user-a');
    const tenantAKeys = Array.from(
      { length: window.localStorage.length },
      (_value, index) => window.localStorage.key(index),
    );

    expect(tenantAKeys).toHaveLength(1);
    expect(window.localStorage.getItem(tenantAKeys[0]!)).toBe('team:team-a');
    expect(readEmployeeScope('tenant-a', 'user-a')).toBe('');

    persistSharedAgentScope(toTeamScope('team-b'), 'tenant-b', 'user-a');
    const values = Array.from(
      { length: window.localStorage.length },
      (_value, index) => window.localStorage.getItem(window.localStorage.key(index)!),
    );
    expect(values).toEqual(expect.arrayContaining(['team:team-a', 'team:team-b']));
    expect(readEmployeeScope('tenant-b', 'user-a')).toBe('');
  });

  it('does not adopt the legacy unscoped selected-agent slot for a verified identity', () => {
    window.localStorage.setItem('ultrarag_enterprise_agent_scope', 'legacy-agent');

    expect(readEmployeeScope('tenant-a', 'user-a')).toBe('');
    clearSharedAgentScope('tenant-a', 'user-a');
    expect(window.localStorage.getItem('ultrarag_enterprise_agent_scope')).toBe('legacy-agent');
  });

  it('namespaces the session filter independently for tenant and user', () => {
    const tenantAUserA = sessionFilterStorageKey('tenant-a', 'user-a');
    const tenantBUserA = sessionFilterStorageKey('tenant-b', 'user-a');
    const tenantAUserB = sessionFilterStorageKey('tenant-a', 'user-b');

    expect(tenantAUserA).not.toBe(tenantBUserA);
    expect(tenantAUserA).not.toBe(tenantAUserB);
    expect(tenantAUserA).not.toBe('skill_agent_session_filter:user-a');

    window.localStorage.setItem(tenantAUserA, 'agent-a');
    expect(window.localStorage.getItem(tenantBUserA)).toBeNull();
    expect(window.localStorage.getItem(tenantAUserB)).toBeNull();
  });

  it('does not create a usable namespace for missing tenant or user identity', () => {
    expect(typeof safely(() => sessionFilterStorageKey('', 'user-a'))).not.toBe('string');
    expect(typeof safely(() => sessionFilterStorageKey('tenant-a', ''))).not.toBe('string');
    expect(safely(() => readEmployeeScope('', 'user-a')) || '').toBe('');
    expect(safely(() => readEmployeeScope('tenant-a', '')) || '').toBe('');
  });
});

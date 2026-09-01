import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');
const OWNED_SOURCES = [
  'pages/dashboard/DashboardPage.tsx',
  'pages/dashboard/ConversationLogsTab.tsx',
  'pages/dashboard/EvolutionPanel.tsx',
  'pages/dashboard/MemoriesTab.tsx',
  'pages/dashboard/ScheduledTasksTab.tsx',
  'pages/scheduled-tasks/ScheduledTaskEditorPage.tsx',
] as const;

/** Read the six dashboard/scheduling production files without mounting their large UI trees. */
function readOwnedSources(): Array<{ file: string; source: string }> {
  return OWNED_SOURCES.map((file) => ({
    file,
    source: fs.readFileSync(path.join(SOURCE_ROOT, file), 'utf8'),
  }));
}

describe('dashboard and scheduling tenant migration boundary', () => {
  it('uses the verified tenant client instead of deployment-wide transport', () => {
    const findings = readOwnedSources().flatMap(({ file, source }) => {
      const usesVerifiedClient = /createTenantClient|tenantClient/.test(source)
        && /useTenantSession/.test(source);
      const directTransport = /\bapi\.(?:get|post|put|delete|blob|postBlob)\s*\(/.test(source);
      return usesVerifiedClient && !directTransport ? [] : [file];
    });

    expect(findings).toEqual([]);
  });

  it('removes fixed and tenant-free request identity from production pages', () => {
    const findings = readOwnedSources().flatMap(({ file, source }) => (
      /\b(?:TENANT_ID|tenant_demo|a2a_codex)\b/.test(source)
        || /tenant_id\s*:/.test(source)
        ? [file]
        : []
    ));

    expect(findings).toEqual([]);
  });

  it('reads selected employee and filter state only through tenant/user namespaces', () => {
    const sources = readOwnedSources().map(({ source }) => source).join('\n');
    expect(sources).toMatch(/tenantUserStorageKey/);
    expect(sources).toMatch(/readEmployeeScope\(tenantId, userId\)/);
    expect(sources).not.toMatch(/readEmployeeScope\(\s*\)/);
    expect(sources).not.toMatch(/persistSharedAgentScope\(\s*[^,()]+\s*\)/);
    expect(sources).not.toMatch(/localStorage\.(?:getItem|setItem|removeItem)\(\s*TENANT/);
  });

  it('cancels and fences employee-scoped action requests across scope revisions', () => {
    const actionSources = OWNED_SOURCES
      .filter((file) => file.includes('EvolutionPanel')
        || file.includes('ConversationLogsTab')
        || file.includes('MemoriesTab')
        || file.includes('ScheduledTasksTab'))
      .map((file) => ({ file, source: readOwnedSources().find((item) => item.file === file)?.source || '' }));
    const findings = actionSources.flatMap(({ file, source }) => {
      const hasRevisionFence = /scopeRevisionRef/.test(source)
        && /agentIdRef/.test(source)
        && /actionControllersRef/.test(source);
      const cancelsOnScopeChange = /cancelActionControllers/.test(source);
      const checksCapturedAgent = /capturedAgentId|actionAgentId|agentIdRef\.current/.test(source);
      return hasRevisionFence && cancelsOnScopeChange && checksCapturedAgent ? [] : [file];
    });

    expect(findings).toEqual([]);
  });

  it('fences scheduled-task saves by task route identity and cancels stale saves', () => {
    const source = readOwnedSources().find((item) => item.file.endsWith('ScheduledTaskEditorPage.tsx'))?.source || '';
    expect(source).toMatch(/routeRevisionRef/);
    expect(source).toMatch(/taskIdRef/);
    expect(source).toMatch(/actionControllersRef/);
    expect(source).toMatch(/cancelActionControllers/);
    expect(source).toMatch(/capturedTaskId|saveTaskId|taskIdRef\.current/);
  });
});

/**
 * Locks the resource-page tenant boundary before the implementation lands.
 * These pages contain several large workflows, so the first contract is a
 * source-level guard that prevents a new direct transport or deployment-wide
 * tenant constant from being reintroduced in this migration slice.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');
const OWNED_SOURCES = [
  'pages/KnowledgePage.tsx',
  'pages/DistillPage.tsx',
  'pages/SkillsPage.tsx',
  'pages/GeneralSkillsPage.tsx',
  'pages/ToolsPage.tsx',
  'components/knowledge/SharedKnowledgeConversionDialog.tsx',
  'components/knowledge/SharedKnowledgeVersionsDialog.tsx',
] as const;

/** Read the production source owned by T037 without importing its UI. */
function readOwnedSources(): Array<{ file: string; source: string }> {
  return OWNED_SOURCES.map((file) => ({
    file,
    source: fs.readFileSync(path.join(SOURCE_ROOT, file), 'utf8'),
  }));
}

describe('knowledge, skill and tool tenant migration boundary', () => {
  it('uses the verified tenant client for every owned network workflow', () => {
    const findings = readOwnedSources().flatMap(({ file, source }) => {
      const hasTenantClient = /createTenantClient|tenantClient/.test(source);
      const directTransport = /\b(?:api|streamGet|streamPost)\s*\./.test(source)
        || /\b(?:api|streamGet|streamPost)\s*\(/.test(source);
      return hasTenantClient && !directTransport ? [] : [file];
    });

    expect(findings).toEqual([]);
  });

  it('removes fixed and pseudo-tenant identifiers from owned production code', () => {
    const findings = readOwnedSources().flatMap(({ file, source }) => (
      /\b(?:TENANT_ID|tenant_demo|a2a_codex)\b/.test(source) ? [file] : []
    ));

    expect(findings).toEqual([]);
  });

  it('derives the page storage namespace from the verified tenant and user', () => {
    const sources = readOwnedSources().map(({ source }) => source).join('\n');
    expect(sources).toMatch(/useTenantSession/);
    expect(sources).toMatch(/tenantId/);
    expect(sources).toMatch(/userId/);
    expect(sources).toMatch(/localStorage|sessionStorage/);
  });
});

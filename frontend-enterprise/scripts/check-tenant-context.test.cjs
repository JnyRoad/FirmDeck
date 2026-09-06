import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanSourceRoot } from './check-tenant-context.cjs';

const temporaryDirectories = [];

function fixtureSource(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firmdeck-tenant-guard-'));
  temporaryDirectories.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, 'utf8');
  }
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('tenant context production guard', () => {
  it('accepts production code that derives tenant identity from context', () => {
    const root = fixtureSource({
      'page.tsx': "const tenantId = context.tenantId;\nvoid tenantId;\n",
    });

    expect(scanSourceRoot(root).findings).toEqual([]);
  });

  it('reports fixed symbols, pseudo tenants, and tenant-free storage keys', () => {
    const root = fixtureSource({
      'bad.ts': [
        "export const TENANT_ID = 'tenant_demo';",
        "const runtime = 'a2a_codex';",
        "const storage = 'ultrarag_enterprise_agent_scope';",
        'void runtime; void storage;',
      ].join('\n'),
    });

    expect(scanSourceRoot(root).findings.map(({ kind }) => kind)).toEqual([
      'definition',
      'fixed-literal',
      'fixed-literal',
      'tenant-free-storage',
    ]);
  });

  it('does not treat tests as production compatibility entries', () => {
    const root = fixtureSource({
      'page.test.ts': "export const TENANT_ID = 'tenant_demo';\n",
      'tests/fixture.ts': "const tenant = 'tenant_demo';\nvoid tenant;\n",
      'safe.ts': 'export const safe = true;\n',
    });

    const result = scanSourceRoot(root);
    expect(result.sourceFiles.map((filename) => path.basename(filename))).toEqual(['safe.ts']);
    expect(result.findings).toEqual([]);
  });
});

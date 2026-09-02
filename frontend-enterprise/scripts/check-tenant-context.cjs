#!/usr/bin/env node
/** Fail the build when production frontend code reintroduces a fixed tenant boundary. */

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'src');
const FIXED_TENANT_SYMBOL = 'TENANT_ID';
const TEST_SOURCE_DIRECTORY_NAMES = new Set(['test', 'tests', '__tests__']);
const FORBIDDEN_TENANT_LITERALS = ['tenant_demo', 'a2a_codex'];
const FORBIDDEN_UNSCOPED_STORAGE_KEYS = [
  'ultrarag_enterprise_agent_scope',
  'skill_agent_session_filter',
  'skill_agent_session_read_at',
  'skill_agent_selected_model_config',
];

/** Return whether a filename is a production TypeScript source rather than a test or declaration. */
function isProductionTypeScriptFile(filename) {
  if (!/\.(?:ts|tsx)$/.test(filename)) return false;
  if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(filename)) return false;
  return !filename.endsWith('.d.ts');
}

/** Recursively collect production TypeScript files in a stable order without external dependencies. */
function collectProductionSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return TEST_SOURCE_DIRECTORY_NAMES.has(entry.name) ? [] : collectProductionSourceFiles(fullPath);
      }
      return isProductionTypeScriptFile(entry.name) ? [fullPath] : [];
    });
}

/** Convert a source offset to the one-based line number used in human-readable checker output. */
function lineNumberAt(sourceText, offset) {
  return sourceText.slice(0, offset).split('\n').length;
}

/** Extract fixed identities and tenant-free storage keys from one production source file. */
function collectTenantContextFindings(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const relativePath = path.relative(projectRoot, filePath).split(path.sep).join('/');
  const findings = [];
  const importPattern = new RegExp(
    `import\\s+(?:type\\s+)?\\{[^}]*\\b${FIXED_TENANT_SYMBOL}\\b[^}]*\\}\\s+from\\s+['\"][^'\"]+['\"]`,
    'g',
  );
  const definitionPattern = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${FIXED_TENANT_SYMBOL}\\s*=`,
    'g',
  );

  for (const [kind, pattern] of [['import', importPattern], ['definition', definitionPattern]]) {
    for (const match of sourceText.matchAll(pattern)) {
      const lineNumber = lineNumberAt(sourceText, match.index);
      findings.push({
        kind,
        relativePath,
        lineNumber,
      });
    }
  }

  for (const literal of FORBIDDEN_TENANT_LITERALS) {
    const pattern = new RegExp(`\\b${literal}\\b`, 'g');
    for (const match of sourceText.matchAll(pattern)) {
      findings.push({
        kind: 'fixed-literal',
        relativePath,
        lineNumber: lineNumberAt(sourceText, match.index),
      });
    }
  }

  for (const storageKey of FORBIDDEN_UNSCOPED_STORAGE_KEYS) {
    const pattern = new RegExp(storageKey, 'g');
    for (const match of sourceText.matchAll(pattern)) {
      findings.push({
        kind: 'tenant-free-storage',
        relativePath,
        lineNumber: lineNumberAt(sourceText, match.index),
      });
    }
  }

  return findings;
}

/** Sort findings so equal inputs always produce equal checker output. */
function sortFindings(findings) {
  return findings.sort((left, right) => (
    left.relativePath.localeCompare(right.relativePath)
    || left.lineNumber - right.lineNumber
    || left.kind.localeCompare(right.kind)
  ));
}

/** Scan one source tree. Exported only so the guard's fail-closed rules can be unit tested. */
function scanSourceRoot(directory) {
  const sourceFiles = collectProductionSourceFiles(directory);
  return {
    sourceFiles,
    findings: sortFindings(sourceFiles.flatMap(collectTenantContextFindings)),
  };
}

/** Report every finding and fail closed; the final compatibility allowlist is intentionally empty. */
function main() {
  const { sourceFiles, findings } = scanSourceRoot(sourceRoot);

  console.log('Tenant context production guard:');
  console.log(`  Production TypeScript files scanned: ${sourceFiles.length}`);
  console.log(`  Noncompliant findings: ${findings.length}`);
  for (const finding of findings) {
    console.log(`  - [${finding.kind}] ${finding.relativePath}:${finding.lineNumber}`);
  }
  if (findings.length > 0) {
    console.error('  Tenant context guard failed: no compatibility entries are allowed.');
    process.exitCode = 1;
    return;
  }
  console.log('  Tenant context guard passed with an empty compatibility boundary.');
}

if (require.main === module) main();

module.exports = { scanSourceRoot };

/**
 * Bootstraps fixture-driven frontend internationalization governance tests. Later checker tasks add
 * rule-specific cases here; this setup test keeps the shared positive fixtures loadable first.
 */

import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { checkCatalogs } from './check-catalog.cjs';
import { checkTypeScriptFiles, fingerprintDiagnostic } from './check-typescript.cjs';
import { formatDiagnostics } from './diagnostics.cjs';
import { extractUsedMessageIds } from '../check-i18n.cjs';

const FIXTURE_ROOT = path.join(process.cwd(), 'scripts', 'i18n', 'fixtures');
const SOURCE_ROOT = path.join(process.cwd(), 'src');
const REPOSITORY_ROOT = path.resolve(process.cwd(), '..');
const FRONTEND_ALLOWLIST_PATH = path.join(process.cwd(), 'scripts', 'i18n', 'legacy-allowlist.json');
const BACKEND_ALLOWLIST_PATH = path.join(REPOSITORY_ROOT, 'scripts', 'i18n', 'legacy-allowlist.json');
const SEMANTIC_MESSAGE_ID = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const EXPECTED_MESSAGE_IDS = [
  'fixture.action.save',
  'fixture.message.greeting',
  'fixture.panel.aria',
  'fixture.panel.title',
];

/**
 * Loads one JSON fixture as an object for assertions. The relative path must stay below the fixture
 * root; this helper only reads files and lets parse or filesystem failures surface to Vitest.
 */
function readJsonFixture(relativePath) {
  const fixturePath = path.join(FIXTURE_ROOT, relativePath);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

/**
 * Parses the positive TSX fixture and returns syntax diagnostics. This helper performs no writes;
 * unreadable input fails through the filesystem and malformed TSX is returned as diagnostics.
 */
function parseTypeScriptFixture(relativePath) {
  const fixturePath = path.join(FIXTURE_ROOT, relativePath);
  const sourceText = fs.readFileSync(fixturePath, 'utf8');
  return ts.createSourceFile(
    fixturePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

/** Recursively collect every matching file below one exact root in deterministic path order. */
function collectFiles(directory, predicate) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? collectFiles(entryPath, predicate)
        : predicate(entryPath) ? [entryPath] : [];
    })
    .sort();
}

/** Collect all production TypeScript sources, excluding only files explicitly named as tests. */
function productionTypeScriptFiles() {
  return collectFiles(
    SOURCE_ROOT,
    (filePath) => /\.tsx?$/.test(filePath) && !/\.(?:test|spec)\.tsx?$/.test(filePath),
  );
}

/** Convert an absolute frontend path to a stable repository-relative failure location. */
function repositoryPath(filePath) {
  return path.relative(REPOSITORY_ROOT, filePath).split(path.sep).join('/');
}

/** Read exact allowlist entries and fail if the file shape is not the governed object contract. */
function readAllowlistEntries(filePath) {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!value || !Array.isArray(value.entries)) {
    throw new Error(`invalid i18n allowlist: ${repositoryPath(filePath)}`);
  }
  return value.entries;
}

/** Find numeric placeholder use only in legacy translation calls or their numeric values object. */
function numericTranslationCallLines(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = new Set();
  /** Inspect a translation call and retain its one-based source line when numeric syntax is used. */
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sourceFile).replace(/\s+/g, '');
      if (callee === 't' || callee.endsWith('.t')) {
        const message = node.arguments[0];
        const messageText = message && (
          ts.isStringLiteral(message) || ts.isNoSubstitutionTemplateLiteral(message)
        ) ? message.text : '';
        const values = node.arguments[1];
        const hasNumericValue = values && ts.isObjectLiteralExpression(values)
          ? values.properties.some((property) => {
            if (!ts.isPropertyAssignment(property)) return false;
            return ts.isNumericLiteral(property.name)
              || (ts.isStringLiteral(property.name) && /^\d+$/.test(property.name.text));
          })
          : false;
        if (/\{\d+\}/.test(messageText) || hasNumericValue) {
          lines.add(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...lines].sort((left, right) => left - right);
}

/**
 * Verifies that the bilingual positive catalogs expose the same hand-checked semantic IDs and ICU
 * parameter. The test reads fixtures only and fails on catalog drift or malformed JSON.
 */
function verifyPositiveCatalogFixtures() {
  const englishCatalog = readJsonFixture(path.join('catalog', 'valid', 'en-US.json'));
  const chineseCatalog = readJsonFixture(path.join('catalog', 'valid', 'zh-CN.json'));

  expect(Object.keys(englishCatalog)).toEqual(EXPECTED_MESSAGE_IDS);
  expect(Object.keys(chineseCatalog)).toEqual(EXPECTED_MESSAGE_IDS);
  expect(englishCatalog['fixture.message.greeting']).toBe('Hello, {name}');
  expect(chineseCatalog['fixture.message.greeting']).toBe('你好，{name}');
}

/**
 * Runs the catalog checker against one fixture directory with a stable used-ID set. This helper is
 * read-only and returns structured diagnostics so tests do not depend on terminal formatting.
 */
function checkCatalogFixture(relativeDirectory, usedMessageIds = EXPECTED_MESSAGE_IDS) {
  const directory = path.join(FIXTURE_ROOT, 'catalog', relativeDirectory);
  return checkCatalogs({
    catalogPaths: {
      'en-US': path.join(directory, 'en-US.json'),
      'zh-CN': path.join(directory, 'zh-CN.json'),
    },
    canonicalLocale: 'en-US',
    usedMessageIds,
  });
}

/** Verify the positive fixture has no catalog-governance diagnostics. */
function verifyPositiveCatalogChecker() {
  expect(checkCatalogFixture('valid')).toEqual([]);
}

/** Verify duplicate JSON properties fail before normal JSON parsing can hide the first value. */
function verifyDuplicateKeyDiagnostic() {
  const diagnostics = checkCatalogFixture('duplicate');
  expect(diagnostics.some((item) => item.rule === 'catalog.duplicateKey')).toBe(true);
}

/** Verify production locale key sets are exact peers of the canonical English catalog. */
function verifyCatalogKeyParityDiagnostics() {
  expect(checkCatalogFixture('missing').some((item) => item.rule === 'catalog.missingKey')).toBe(true);
  expect(checkCatalogFixture('extra').some((item) => item.rule === 'catalog.extraKey')).toBe(true);
}

/** Verify malformed ICU and incompatible parameter structures produce distinct actionable rules. */
function verifyIcuStructureDiagnostics() {
  expect(checkCatalogFixture('invalid-icu').some((item) => item.rule === 'catalog.invalidIcu')).toBe(true);
  expect(
    checkCatalogFixture('parameter-mismatch').some(
      (item) => item.rule === 'catalog.parameterStructure',
    ),
  ).toBe(true);
  expect(
    checkCatalogFixture('template-conflict').some(
      (item) => item.rule === 'catalog.parameterStructure',
    ),
  ).toBe(true);
}

/** Verify prose-shaped IDs and catalog entries unused by source are reported independently. */
function verifyIdentifierAndStaleDiagnostics() {
  expect(checkCatalogFixture('invalid-id').some((item) => item.rule === 'catalog.invalidId')).toBe(true);
  expect(
    checkCatalogFixture('valid', ['fixture.action.save']).some(
      (item) => item.rule === 'catalog.staleKey',
    ),
  ).toBe(true);
}

/** Verify the same diagnostics have deterministic human and JSON representations for CI artifacts. */
function verifyDiagnosticFormats() {
  const diagnostics = checkCatalogFixture('missing');
  const human = formatDiagnostics(diagnostics, 'human');
  const json = JSON.parse(formatDiagnostics(diagnostics, 'json'));

  expect(human).toContain('catalog.missingKey');
  expect(json).toEqual(diagnostics);
}

/** Verify the positive TypeScript fixture introduces no product-text or locale diagnostics. */
function verifyPositiveTypeScriptChecker() {
  const filePath = path.join(FIXTURE_ROOT, 'typescript', 'valid.tsx');
  expect(checkTypeScriptFiles({ filePaths: [filePath] })).toEqual([]);
}

/** Verify every governed TypeScript sink and formatting defect is recognized from its AST context. */
function verifyTypeScriptSinkDiagnostics() {
  const filePath = path.join(FIXTURE_ROOT, 'typescript', 'invalid-sinks.tsx');
  const rules = new Set(checkTypeScriptFiles({ filePaths: [filePath] }).map((item) => item.rule));

  expect(rules).toEqual(
    new Set([
      'typescript.broadIgnore',
      'typescript.dynamicMessageId',
      'typescript.fixedLocale',
      'typescript.hardcodedAttribute',
      'typescript.hardcodedClipboardNotice',
      'typescript.hardcodedDocumentTitle',
      'typescript.hardcodedDownloadName',
      'typescript.hardcodedJsx',
      'typescript.hardcodedNativeDialog',
      'typescript.hardcodedPostMessage',
      'typescript.hardcodedSourceKey',
      'typescript.hardcodedToast',
      'typescript.invalidIgnore',
    ]),
  );
}

/** Verify exact, current fingerprints suppress only their one diagnostic and stale hashes do not. */
function verifyExactAllowlistRatchet() {
  const filePath = path.join(FIXTURE_ROOT, 'typescript', 'invalid-sinks.tsx');
  const diagnostics = checkTypeScriptFiles({ filePaths: [filePath] });
  const target = diagnostics.find((item) => item.rule === 'typescript.hardcodedDownloadName');
  expect(target).toBeDefined();

  const validEntry = {
    file: target.file,
    rule: target.rule,
    fingerprint: fingerprintDiagnostic(target),
    owner: 'frontend-platform',
    reason: 'fixture proves one exact compatibility entry',
    expires: '2099-12-31',
  };
  const suppressed = checkTypeScriptFiles({ filePaths: [filePath], allowlistEntries: [validEntry] });
  const stale = checkTypeScriptFiles({
    filePaths: [filePath],
    allowlistEntries: [{ ...validEntry, fingerprint: 'sha256:stale' }],
  });

  expect(suppressed.filter((item) => item.rule === target.rule)).toHaveLength(0);
  expect(stale.some((item) => item.rule === target.rule)).toBe(true);
}

/** Run the TypeScript checker against one exact fixture with stable frontend-relative paths. */
function checkTypeScriptFixture(relativePath) {
  const filePath = path.join(FIXTURE_ROOT, 'typescript', relativePath);
  return checkTypeScriptFiles({ filePaths: [filePath] });
}

/** Verify an identifier explicitly typed as MessageId is accepted as a semantic message lookup. */
function verifyTypedMessageIdIdentifier() {
  expect(checkTypeScriptFixture('valid-message-id-identifier.tsx')).toEqual([]);
}

/** Verify a property explicitly typed as MessageId is accepted as a semantic message lookup. */
function verifyTypedMessageIdProperty() {
  expect(checkTypeScriptFixture('valid-message-id-property.tsx')).toEqual([]);
}

/** Verify locale-copy, locale-branch, and hand-built plural/unit text receive dedicated findings. */
function verifyLocaleFormattingDiagnostics() {
  const diagnostics = checkTypeScriptFixture('invalid-locale-formatting.tsx');
  const localeCopy = diagnostics.filter((item) => item.rule === 'typescript.localeCopy');
  const manualFormatting = diagnostics.filter(
    (item) => item.rule === 'typescript.manualLocaleFormatting',
  );

  expect(localeCopy.length).toBe(4);
  expect(manualFormatting.length).toBe(3);
  expect(manualFormatting.map((item) => item.source)).toEqual(expect.arrayContaining([
    "count + ' items'",
    "`${count} KB`",
    "count === 1 ? 'item' : 'items'",
  ]));
}

/** Verify raw business values, technical enum branches, Intl formatting, and translated branches stay unreported. */
function verifyLocaleFormattingBoundaries() {
  const diagnostics = checkTypeScriptFixture('valid-locale-formatting.tsx');
  expect(diagnostics.filter((item) => (
    item.rule === 'typescript.localeCopy' ||
    item.rule === 'typescript.manualLocaleFormatting'
  ))).toEqual([]);
}

/** Verify both descriptor and descriptor-property formatMessage forms retain their type contract. */
function verifyTypedMessageDescriptor() {
  expect(checkTypeScriptFixture('valid-message-descriptor.tsx')).toEqual([]);
}

/** Verify source usage extraction follows explicit typed translator calls and descriptor variables. */
function verifyTypedHelperUsageExtraction() {
  const filePath = path.join(FIXTURE_ROOT, 'typescript', 'typed-helper-usage.tsx');
  expect(extractUsedMessageIds([filePath])).toEqual([
    'fixture.alias.one',
    'fixture.alias.two',
    'fixture.array.one',
    'fixture.array.two',
    'fixture.conditional.one',
    'fixture.conditional.two',
    'fixture.descriptor.variable',
    'fixture.fallback.message',
    'fixture.helper.message',
    'fixture.map.message',
  ]);
}

/** Verify generated backend message_key fields participate in stale-key usage extraction. */
function verifyGeneratedMessageKeyExtraction() {
  const generatedPath = path.join(SOURCE_ROOT, 'i18n', 'generated', 'backendContract.ts');
  const usedMessageIds = extractUsedMessageIds([generatedPath]);
  expect(usedMessageIds).toContain('errors.a2a.agentCardError');
}

/** Verify a fail-closed type-predicate guard validates an unknown descriptor before translation. */
function verifyGuardedMessageDescriptor() {
  expect(checkTypeScriptFixture('valid-guarded-message-descriptor.tsx')).toEqual([]);
}

/** Verify a plain string property cannot masquerade as a validated semantic message ID. */
function verifyUntypedMessageIdProperty() {
  const diagnostics = checkTypeScriptFixture('invalid-message-id-property.tsx');
  expect(diagnostics.map((item) => item.rule)).toEqual(['typescript.dynamicMessageId']);
}

/** Select one exact expression-attribute diagnostic by its source evidence. */
function expressionAttributeDiagnostic(source) {
  return checkTypeScriptFixture('invalid-expression-attributes.tsx')
    .find((item) => item.source === source);
}

/** Verify a string literal nested in a JSX expression remains a governed visible attribute. */
function verifyExpressionAttribute() {
  expect(expressionAttributeDiagnostic("'Channel identity'")?.rule)
    .toBe('typescript.hardcodedAttribute');
}

/** Verify interpolated product prose in a JSX attribute is detected as one stable AST sink. */
function verifyTemplateAttribute() {
  expect(expressionAttributeDiagnostic('`${name} identity binding`')?.rule)
    .toBe('typescript.hardcodedAttribute');
}

/** Verify both branches of a conditional attribute cannot hide product-authored literals. */
function verifyConditionalAttribute() {
  const source = "mode === 'plaza' ? 'Copy from plaza' : 'Copy from employee'";
  expect(expressionAttributeDiagnostic(source)?.rule).toBe('typescript.hardcodedAttribute');
}

/** Verify local object labels flowing through a map callback into JSX are reported at their origin. */
function verifyObjectLabelDataflow() {
  const diagnostics = checkTypeScriptFixture('invalid-object-label.tsx');
  expect(diagnostics.map((item) => [item.rule, item.source])).toEqual([
    ['typescript.hardcodedJsx', "'Bot ID'"],
    ['typescript.hardcodedJsx', "'Bot secret'"],
  ]);
}

/** Verify dynamic raw business values in visible attributes do not become hardcoded-text findings. */
function verifyRawAttributeValues() {
  expect(checkTypeScriptFixture('valid-raw-attributes.tsx')).toEqual([]);
}

/** Verify externally supplied object labels remain raw when no local product literal feeds the map. */
function verifyExternalObjectLabels() {
  expect(checkTypeScriptFixture('valid-external-object-label.tsx')).toEqual([]);
}

/** Verify exact raw markup protects a local third-party label without using a broad ignore. */
function verifyLocalRawObjectLabels() {
  expect(checkTypeScriptFixture('valid-local-raw-object-label.tsx')).toEqual([]);
}

/** Verify local product prose remains visible to the checker across supported expression dataflow. */
function verifyLocalDataflowDiagnostics() {
  const diagnostics = checkTypeScriptFixture('invalid-local-dataflow.tsx');
  const sources = diagnostics
    .filter((item) => item.rule.startsWith('typescript.'))
    .map((item) => item.source);

  expect(sources).toEqual(expect.arrayContaining([
    "'Audit history'",
    "'Choose a layout for the graph'",
    "'Force-directed layout'",
    "'Pending approval'",
    "'Export report'",
  ]));
  expect(sources.some((source) => source.includes('UI_COPY.pageTitle'))).toBe(true);
  expect(sources.some((source) => source.includes("'Could not save '") && source.includes("'layout'"))).toBe(true);
  expect(diagnostics.some((item) => item.rule === 'typescript.hardcodedJsx')).toBe(true);
  expect(diagnostics.some((item) => item.rule === 'typescript.hardcodedAttribute')).toBe(true);
  expect(diagnostics.some((item) => item.rule === 'typescript.hardcodedToast')).toBe(true);
  expect(diagnostics.some((item) => item.rule === 'typescript.hardcodedNativeDialog')).toBe(true);
  expect(diagnostics.some((item) => item.rule === 'typescript.hardcodedDocumentTitle')).toBe(true);
  expect(diagnostics.some((item) => item.rule === 'typescript.hardcodedDownloadName')).toBe(true);
  expect(diagnostics.some((item) => item.rule === 'typescript.hardcodedPostMessage')).toBe(true);
}

/** Verify external payloads, user input, exact protocol tokens, and raw markup stay unreported. */
function verifyDataflowRawBoundaries() {
  expect(checkTypeScriptFixture('valid-dataflow-boundaries.tsx')).toEqual([]);
}

/** Verify backend event and trace product fields are rejected at chrome and JSX sinks. */
function verifyTraceSinkDiagnostics() {
  const diagnostics = checkTypeScriptFixture('invalid-trace-sinks.tsx')
    .filter((item) => item.rule === 'typescript.hardcodedTraceText');

  expect(diagnostics).toHaveLength(8);
  expect(diagnostics.map((item) => item.source)).toEqual(expect.arrayContaining([
    'item.data.message',
    'item.data.status_text',
    'item.data.text',
    'line.text',
    'line.detail',
    'line.outputTitle',
  ]));
}

/** Verify semantic event mapping and explicitly raw output boundaries are accepted. */
function verifyTraceSinkBoundaries() {
  expect(
    checkTypeScriptFixture('valid-trace-sinks.tsx')
      .filter((item) => item.rule === 'typescript.hardcodedTraceText'),
  ).toEqual([]);
}

/** Verify test-only TSX is excluded even when a caller passes the path directly to the checker. */
function verifyTestFileExclusion() {
  expect(checkTypeScriptFixture('ignored-surface.test.tsx')).toEqual([]);
}

/** Verify declaration-only files are excluded from production message-ID diagnostics. */
function verifyDeclarationFileExclusion() {
  expect(checkTypeScriptFixture('ignored-types.d.ts')).toEqual([]);
}

/** Verify repeated checks preserve path, AST kind, source evidence, and diagnostic fingerprint. */
function verifyStableExpressionDiagnostic() {
  const source = "mode === 'plaza' ? 'Copy from plaza' : 'Copy from employee'";
  const first = expressionAttributeDiagnostic(source);
  const second = expressionAttributeDiagnostic(source);

  expect(first).toEqual(second);
  expect(first).toMatchObject({
    astKind: 'ConditionalExpression',
    file: 'scripts/i18n/fixtures/typescript/invalid-expression-attributes.tsx',
    rule: 'typescript.hardcodedAttribute',
    source,
  });
  expect(fingerprintDiagnostic(first)).toBe(fingerprintDiagnostic(second));
  expect(fingerprintDiagnostic(first)).toMatch(/^sha256:[a-f0-9]{64}$/);
}

/** Require every repository i18n catalog to use semantic IDs and remove source-key catalog files. */
function verifyFinalCatalogAbsence() {
  const catalogFiles = collectFiles(
    path.join(SOURCE_ROOT, 'i18n'),
    (filePath) => filePath.endsWith('.json'),
  );
  const findings = catalogFiles.flatMap((filePath) => {
    const catalog = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const naturalKeys = Object.keys(catalog).filter((key) => !SEMANTIC_MESSAGE_ID.test(key));
    const sourceKeyCatalog = /source-key/i.test(path.basename(filePath));
    if (!sourceKeyCatalog && naturalKeys.length === 0) return [];
    return [{
      file: repositoryPath(filePath),
      sourceKeyCatalog,
      naturalKeyCount: naturalKeys.length,
      samples: naturalKeys.slice(0, 3),
    }];
  });

  expect(findings, 'source-key catalogs and natural-language message IDs must be removed').toEqual([]);
}

/** Require every production translation call to use a semantic ID with no compatibility baseline. */
function verifyFinalNaturalTranslationKeyAbsence() {
  const diagnostics = checkTypeScriptFiles({
    filePaths: productionTypeScriptFiles(),
    rootDir: REPOSITORY_ROOT,
    allowlistEntries: [],
  })
    .filter((item) => item.rule === 'typescript.hardcodedSourceKey')
    .map((item) => `${item.file}:${item.line}`);

  expect(diagnostics, 'natural-language translation calls remain at these production paths').toEqual([]);
}

/** Require removal of numeric placeholder catalogs, call sites, and legacy numeric value types. */
function verifyFinalNumericPlaceholderAbsence() {
  const productionFiles = productionTypeScriptFiles();
  const catalogFiles = collectFiles(
    path.join(SOURCE_ROOT, 'i18n'),
    (filePath) => filePath.endsWith('.json'),
  );
  const typeScriptFindings = productionFiles.flatMap((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    const callLines = numericTranslationCallLines(filePath);
    const numericValueApi = /Record\s*<\s*string\s*\|\s*number\s*,/.test(source);
    if (callLines.length === 0 && !numericValueApi) return [];
    return [{
      file: repositoryPath(filePath),
      callLines,
      numericValueApi,
    }];
  });
  const catalogFindings = catalogFiles.flatMap((filePath) => {
    const catalog = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const numericEntries = Object.entries(catalog).filter(
      ([key, value]) => /\{\d+\}/.test(key) || /\{\d+\}/.test(String(value)),
    );
    return numericEntries.length === 0 ? [] : [{
      file: repositoryPath(filePath),
      numericEntryCount: numericEntries.length,
      samples: numericEntries.slice(0, 3).map(([key]) => key),
    }];
  });

  expect(
    [...typeScriptFindings, ...catalogFindings],
    'numeric placeholder compatibility remains at these production paths',
  ).toEqual([]);
}

/** Require zero broad JSX ignores and zero frontend/backend compatibility allowlist entries. */
function verifyFinalIgnoreAndAllowlistAbsence() {
  const broadIgnoreFindings = checkTypeScriptFiles({
    filePaths: productionTypeScriptFiles(),
    rootDir: REPOSITORY_ROOT,
    allowlistEntries: [],
  })
    .filter((item) => item.rule === 'typescript.broadIgnore')
    .map((item) => `${item.file}:${item.line}`);
  const allowlistFindings = [FRONTEND_ALLOWLIST_PATH, BACKEND_ALLOWLIST_PATH].flatMap(
    (filePath) => readAllowlistEntries(filePath).map((entry) => ({
      file: repositoryPath(filePath),
      entry,
    })),
  );

  expect.soft(broadIgnoreFindings, 'broad data-i18n-ignore sites remain').toEqual([]);
  expect.soft(allowlistFindings, 'compatibility allowlist entries remain').toEqual([]);
}

/**
 * Verifies that the positive TypeScript fixture is valid TSX before rule-specific checker tests use
 * it. The test reads and parses one fixture without executing application code.
 */
function verifyPositiveTypeScriptFixture() {
  const sourceFile = parseTypeScriptFixture(path.join('typescript', 'valid.tsx'));

  expect(sourceFile.parseDiagnostics).toEqual([]);
}

/**
 * Registers the fixture harness smoke tests with Vitest. Registration has no external side effects
 * beyond Vitest's in-memory suite state and fails only when the test runner rejects the suite.
 */
function registerFixtureHarnessTests() {
  it('loads aligned bilingual catalog fixtures', verifyPositiveCatalogFixtures);
  it('parses the localized TypeScript fixture as TSX', verifyPositiveTypeScriptFixture);
  it('accepts the valid catalog contract', verifyPositiveCatalogChecker);
  it('rejects duplicate catalog keys', verifyDuplicateKeyDiagnostic);
  it('rejects missing and extra locale keys', verifyCatalogKeyParityDiagnostics);
  it('rejects invalid ICU and incompatible parameter structures', verifyIcuStructureDiagnostics);
  it('rejects invalid IDs and stale catalog entries', verifyIdentifierAndStaleDiagnostics);
  it('formats diagnostics for humans and JSON artifacts', verifyDiagnosticFormats);
  it('accepts the valid TypeScript sink fixture', verifyPositiveTypeScriptChecker);
  it('detects every governed TypeScript sink and fixed locale', verifyTypeScriptSinkDiagnostics);
  it('ratchets legacy findings with exact expiring fingerprints', verifyExactAllowlistRatchet);
}

/** Register the final migration absence tests without weakening their intentionally strict scans. */
function registerFinalAbsenceTests() {
  const wholeRepositoryScanTimeoutMs = 30_000;

  it(
    'requires source-key catalogs and natural-language catalog keys to be absent',
    verifyFinalCatalogAbsence,
    wholeRepositoryScanTimeoutMs,
  );
  it(
    'requires natural-language translation calls to be absent',
    verifyFinalNaturalTranslationKeyAbsence,
    wholeRepositoryScanTimeoutMs,
  );
  it(
    'requires numeric placeholder compatibility to be absent',
    verifyFinalNumericPlaceholderAbsence,
    wholeRepositoryScanTimeoutMs,
  );
  it(
    'requires broad ignores and compatibility allowlists to be absent',
    verifyFinalIgnoreAndAllowlistAbsence,
    wholeRepositoryScanTimeoutMs,
  );
}

/** Register T080 fixture contracts for typed IDs, expression sinks, dataflow, and exclusions. */
function registerTypeScriptT080Tests() {
  it('accepts a typed MessageId identifier', verifyTypedMessageIdIdentifier);
  it('accepts a typed MessageId property', verifyTypedMessageIdProperty);
  it('accepts typed message descriptor forms', verifyTypedMessageDescriptor);
  it('extracts IDs from typed helpers and descriptor variables', verifyTypedHelperUsageExtraction);
  it('extracts generated backend message_key values', verifyGeneratedMessageKeyExtraction);
  it('accepts a fail-closed guarded message descriptor', verifyGuardedMessageDescriptor);
  it('rejects an unvalidated string property as a message ID', verifyUntypedMessageIdProperty);
  it('detects a literal JSX attribute expression', verifyExpressionAttribute);
  it('detects an interpolated JSX attribute template', verifyTemplateAttribute);
  it('detects a conditional JSX attribute expression', verifyConditionalAttribute);
  it('detects object-configured labels rendered through map', verifyObjectLabelDataflow);
  it('accepts raw business values in attributes', verifyRawAttributeValues);
  it('accepts externally supplied object labels', verifyExternalObjectLabels);
  it('accepts exact local raw object labels', verifyLocalRawObjectLabels);
  it('detects local product prose through bounded dataflow', verifyLocalDataflowDiagnostics);
  it('preserves raw, user, and protocol dataflow boundaries', verifyDataflowRawBoundaries);
  it('excludes test-only TSX files', verifyTestFileExclusion);
  it('excludes declaration-only TypeScript files', verifyDeclarationFileExclusion);
  it('keeps expression diagnostics and fingerprints stable', verifyStableExpressionDiagnostic);
}

/** Register T096 event and trace sink contracts without changing production behavior. */
function registerTypeScriptT096Tests() {
  it('rejects direct backend event and trace product fields', verifyTraceSinkDiagnostics);
  it('accepts mapped messages and explicit raw trace payloads', verifyTraceSinkBoundaries);
}

/** Register T109 locale-copy and manual plural/unit formatting contracts. */
function registerTypeScriptT109Tests() {
  it('detects locale copy and manual locale formatting', verifyLocaleFormattingDiagnostics);
  it('preserves locale formatting raw and technical boundaries', verifyLocaleFormattingBoundaries);
}

describe('frontend i18n governance fixture harness', registerFixtureHarnessTests);
describe('TypeScript checker T080 contracts', registerTypeScriptT080Tests);
describe('TypeScript checker T096 event and trace contracts', registerTypeScriptT096Tests);
describe('TypeScript checker T109 locale formatting contracts', registerTypeScriptT109Tests);
describe('final legacy absence ratchets', registerFinalAbsenceTests);

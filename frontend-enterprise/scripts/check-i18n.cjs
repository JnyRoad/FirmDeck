#!/usr/bin/env node
/** Thin repository CLI composing catalog and TypeScript internationalization governance checks. */

const fs = require('node:fs');
const path = require('node:path');

const ts = require('typescript');

const { checkCatalogs } = require('./i18n/check-catalog.cjs');
const { checkTypeScriptFiles } = require('./i18n/check-typescript.cjs');
const { formatDiagnostics, sortDiagnostics } = require('./i18n/diagnostics.cjs');

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(projectRoot, 'src');
const allowlistPath = path.join(__dirname, 'i18n', 'legacy-allowlist.json');
const SEMANTIC_MESSAGE_ID = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;

/** Recursively collect production TypeScript sources while excluding generated/test-only inputs. */
function collectSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(fullPath);
    if (!/\.(?:ts|tsx)$/.test(entry.name)) return [];
    if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) return [];
    if (entry.name.endsWith('.d.ts')) return [];
    return [fullPath];
  });
}

/** Build a TypeScript program so usage extraction can inspect explicit helper parameter types. */
function createUsageProgram(filePaths) {
  const searchRoot = filePaths[0] ? path.dirname(filePaths[0]) : projectRoot;
  const configPath = ts.findConfigFile(searchRoot, fs.existsSync, 'tsconfig.json');
  let compilerOptions = {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2020,
  };
  if (configPath) {
    const config = ts.readConfigFile(configPath, (filePath) => fs.readFileSync(filePath, 'utf8'));
    if (!config.error) {
      compilerOptions = {
        ...ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).options,
        noEmit: true,
        skipLibCheck: true,
      };
    }
  }
  return ts.createProgram({
    rootNames: filePaths.map((filePath) => path.resolve(filePath)),
    options: compilerOptions,
  });
}

/** Resolve whether a TypeScript type is an explicit semantic MessageId contract. */
function isSemanticMessageIdType(type, checker, visited = new Set()) {
  if (!type || visited.has(type)) return false;
  visited.add(type);
  if (type.aliasSymbol?.name === 'MessageId' || type.symbol?.name === 'MessageId') return true;
  if (type.flags & ts.TypeFlags.StringLiteral) return SEMANTIC_MESSAGE_ID.test(type.value);
  if (type.isUnion?.() && type.types.length > 0) {
    const requiredMembers = type.types.filter(
      (member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
    );
    return requiredMembers.length > 0 && requiredMembers.every(
      (member) => isSemanticMessageIdType(member, checker, new Set(visited)),
    );
  }
  if (type.aliasSymbol) {
    const declaredType = checker.getDeclaredTypeOfSymbol(type.aliasSymbol);
    if (declaredType !== type && isSemanticMessageIdType(declaredType, checker, visited)) return true;
  }
  const baseConstraint = checker.getBaseConstraintOfType?.(type);
  if (baseConstraint && baseConstraint !== type && isSemanticMessageIdType(baseConstraint, checker, new Set(visited))) return true;
  return false;
}

/** Return whether a type is a typed array or record whose values are governed MessageIds. */
function isSemanticMessageIdCollectionType(type, checker) {
  if (!type) return false;
  const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  return Boolean(elementType && isSemanticMessageIdType(elementType, checker));
}

/** Resolve the narrow contextual type of a property value without inferring arbitrary raw strings. */
function contextualValueType(node, checker) {
  const directType = checker.getContextualType(node);
  if (directType) return directType;
  const parent = node.parent;
  if (!ts.isPropertyAssignment(parent) || !ts.isObjectLiteralExpression(parent.parent)) return undefined;
  const objectType = checker.getContextualType(parent.parent);
  if (!objectType) return undefined;
  const propertyName = ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)
    ? parent.name.text
    : '';
  if (!propertyName) return undefined;
  const property = checker.getPropertyOfType(objectType, propertyName);
  return property ? checker.getTypeOfSymbolAtLocation(property, node) : undefined;
}

/** Return true only when an expression has an explicit MessageId or typed collection context. */
function hasSemanticMessageIdContext(node, checker) {
  const context = contextualValueType(node, checker);
  if (isSemanticMessageIdType(context, checker)) return true;
  if (isSemanticMessageIdCollectionType(context, checker)) return true;

  let candidate = node;
  while (
    ts.isParenthesizedExpression(candidate) ||
    ts.isAsExpression(candidate) ||
    ts.isTypeAssertionExpression(candidate) ||
    ts.isNonNullExpression(candidate) ||
    ts.isSatisfiesExpression(candidate)
  ) {
    if (ts.isAsExpression(candidate) || ts.isTypeAssertionExpression(candidate) || ts.isSatisfiesExpression(candidate)) {
      const assertedType = checker.getTypeFromTypeNode(candidate.type);
      if (isSemanticMessageIdType(assertedType, checker) || isSemanticMessageIdCollectionType(assertedType, checker)) return true;
    }
    candidate = candidate.expression;
  }
  return false;
}

/** Add static semantic IDs from a bounded expression; dynamic construction and arbitrary flow stop here. */
function addStaticMessageIds(node, messageIds, checker, sourceFile, resolveIdentifiers = false, visited = new Set()) {
  if (!node || visited.has(node)) return;
  visited.add(node);

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (SEMANTIC_MESSAGE_ID.test(node.text)) messageIds.add(node.text);
    return;
  }
  if (ts.isJsxExpression(node)) {
    addStaticMessageIds(node.expression, messageIds, checker, sourceFile, resolveIdentifiers, visited);
    return;
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    addStaticMessageIds(node.expression, messageIds, checker, sourceFile, resolveIdentifiers, visited);
    return;
  }
  if (ts.isConditionalExpression(node)) {
    addStaticMessageIds(node.whenTrue, messageIds, checker, sourceFile, resolveIdentifiers, visited);
    addStaticMessageIds(node.whenFalse, messageIds, checker, sourceFile, resolveIdentifiers, visited);
    return;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const context = contextualValueType(node, checker);
    if (isSemanticMessageIdCollectionType(context, checker)) {
      node.elements.forEach((element) => {
        addStaticMessageIds(element, messageIds, checker, sourceFile, resolveIdentifiers, visited);
      });
    }
    return;
  }
  if (!resolveIdentifiers || !ts.isIdentifier(node) || !checker) return;

  const symbol = checker.getSymbolAtLocation(node);
  for (const declaration of symbol?.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      declaration.getSourceFile() === sourceFile &&
      (
        hasSemanticMessageIdContext(declaration.initializer, checker) ||
        isSemanticMessageIdType(checker.getTypeAtLocation(node), checker)
      )
    ) {
      addStaticMessageIds(
        declaration.initializer,
        messageIds,
        checker,
        sourceFile,
        true,
        visited,
      );
    }
  }
}

/** Add statically known IDs for every helper argument whose signature explicitly requires MessageId. */
function addTypedMessageIdArguments(call, messageIds, checker, sourceFile) {
  const signature = checker.getResolvedSignature(call);
  if (!signature) return;
  signature.parameters.forEach((parameter, index) => {
    const argument = call.arguments[index];
    if (!argument) return;
    const parameterType = checker.getTypeOfSymbolAtLocation(parameter, call);
    if (!isSemanticMessageIdType(parameterType, checker)) return;
    addStaticMessageIds(argument, messageIds, checker, sourceFile, true);
  });
}

/** Extract statically declared semantic message IDs for stale-key validation. */
function extractUsedMessageIds(filePaths) {
  const messageIds = new Set();
  const program = createUsageProgram(filePaths);
  const checker = program.getTypeChecker();
  for (const filePath of filePaths) {
    const isGeneratedBackendContract = filePath.endsWith(
      path.join('src', 'i18n', 'generated', 'backendContract.ts'),
    );
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const sourceFile = program.getSourceFile(path.resolve(filePath)) || ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (ts.isPropertyAssignment(node)) {
        const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
        const value = node.initializer;
        if (
          (/(?:^id$|Id$|MessageId$)/.test(name) ||
            (isGeneratedBackendContract && name === 'message_key') ||
            hasSemanticMessageIdContext(value, checker))
        ) {
          addStaticMessageIds(value, messageIds, checker, sourceFile);
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = node.initializer;
        if (
          /(?:_MESSAGE_ID|MessageId)$/.test(node.name.text) &&
          (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) &&
          SEMANTIC_MESSAGE_ID.test(value.text)
        ) {
          messageIds.add(value.text);
        } else if (hasSemanticMessageIdContext(value, checker)) {
          addStaticMessageIds(value, messageIds, checker, sourceFile);
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sourceFile);
        if (callee.endsWith('createMessageDescriptor')) {
          addStaticMessageIds(node.arguments[0], messageIds, checker, sourceFile, true);
        }
        if (callee === 't' || callee.endsWith('.t')) {
          addStaticMessageIds(node.arguments[0], messageIds, checker, sourceFile);
        }
        addTypedMessageIdArguments(node, messageIds, checker, sourceFile);
        if (callee.endsWith('formatMessage')) {
          const descriptor = node.arguments[0];
          if (descriptor && ts.isObjectLiteralExpression(descriptor)) {
            for (const property of descriptor.properties) {
              if (
                ts.isPropertyAssignment(property) &&
                ((ts.isIdentifier(property.name) && property.name.text === 'id') ||
                  (ts.isStringLiteral(property.name) && property.name.text === 'id'))
              ) {
                addStaticMessageIds(property.initializer, messageIds, checker, sourceFile, true);
              }
            }
          }
        }
      }
      if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === 'id') {
        const tag = node.parent.parent;
        if (
          (ts.isJsxOpeningElement(tag) || ts.isJsxSelfClosingElement(tag)) &&
          tag.tagName.getText(sourceFile).endsWith('FormattedMessage') &&
          node.initializer
        ) {
          addStaticMessageIds(node.initializer, messageIds, checker, sourceFile, true);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...messageIds].sort();
}

/** Load the exact compatibility allowlist and reject ambiguous top-level shapes. */
function loadAllowlist() {
  const payload = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.entries)) {
    throw new Error('i18n legacy allowlist must use schemaVersion 1 with an entries array');
  }
  return payload.entries;
}

/** Resolve CLI output format without allowing silent unknown arguments. */
function outputFormat(argv) {
  const formatArgument = argv.find((argument) => argument.startsWith('--format='));
  const format = formatArgument ? formatArgument.slice('--format='.length) : 'human';
  if (!['human', 'json'].includes(format)) throw new Error(`unsupported --format: ${format}`);
  const unknown = argv.filter((argument) => !argument.startsWith('--format='));
  if (unknown.length > 0) throw new Error(`unknown i18n checker arguments: ${unknown.join(', ')}`);
  return format;
}

/** Run all frontend governance checks and fail the process when any unsuppressed defect remains. */
function main() {
  const format = outputFormat(process.argv.slice(2));
  const filePaths = collectSourceFiles(sourceRoot);
  const usedMessageIds = extractUsedMessageIds(filePaths);
  const typeScriptDiagnostics = checkTypeScriptFiles({
    filePaths,
    allowlistEntries: loadAllowlist(),
    rootDir: projectRoot,
  });
  const catalogDiagnostics = checkCatalogs({
    catalogPaths: {
      'en-US': path.join(sourceRoot, 'i18n', 'messages', 'en-US.json'),
      'zh-CN': path.join(sourceRoot, 'i18n', 'messages', 'zh-CN.json'),
    },
    canonicalLocale: 'en-US',
    usedMessageIds,
  });
  const diagnostics = sortDiagnostics([...typeScriptDiagnostics, ...catalogDiagnostics]);

  if (diagnostics.length > 0) {
    process.stderr.write(`${formatDiagnostics(diagnostics, format)}\n`);
    process.exitCode = 1;
    return;
  }
  const success = {
    status: 'ok',
    filesChecked: filePaths.length,
    messagesChecked: usedMessageIds.length,
  };
  process.stdout.write(
    format === 'json'
      ? `${JSON.stringify(success, null, 2)}\n`
      : `i18n governance OK: ${success.filesChecked} files, ${success.messagesChecked} messages\n`,
  );
}

if (require.main === module) main();

module.exports = {
  extractUsedMessageIds,
};

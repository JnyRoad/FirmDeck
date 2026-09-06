/** TypeScript AST checks for product text sinks, fixed locales, dynamic IDs, and exact ignores. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ts = require('typescript');

const { createDiagnostic, sortDiagnostics } = require('./diagnostics.cjs');

const SEMANTIC_ID_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const TECHNICAL_TOKEN_SET = new Set([
  'A2A',
  'API',
  'CLI',
  'CSV',
  'DELETE',
  'GET',
  'HEAD',
  'HTML',
  'HTTP',
  'HTTPS',
  'JSON',
  'MCP',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'RPC',
  'SDK',
  'SSE',
  'TRACE',
  'URL',
  'UUID',
  'XML',
]);
const LOCALIZED_ATTRIBUTE_NAMES = new Set([
  'aria-label',
  'alt',
  'defaultValue',
  'placeholder',
  'title',
]);
const POST_MESSAGE_TEXT_FIELDS = new Set([
  'description',
  'error',
  'label',
  'message',
  'status_text',
  'text',
  'title',
]);
const TRACE_PRODUCT_TEXT_FIELDS = new Set([
  'detail',
  'message',
  'outputTitle',
  'status_text',
  'text',
]);
const TRACE_RAW_FIELDS = new Set(['code', 'output', 'stderr', 'stdout']);
const TRACE_SINK_NAMES = new Set(['upsertVisibleTraceLine']);
const TRACE_SAFE_SINK_NAMES = new Set(['traceChromeText']);
const TRACE_TYPE_NAME_PATTERN = /(?:TraceLineRead|TraceLine|StreamEvent|ChatSessionEventRead)$/;
const SUPPORTED_LOCALE_TAGS = new Set(['en-US', 'zh-CN']);
const LOCALE_COPY_NAME_PATTERN = /(?:^|_)COPY$/i;
const MANUAL_COUNT_UNIT_PATTERN = /(?:^|[\s\u00a0])(?:item|items|user|users|member|members|file|files|task|tasks|result|results|call|calls|record|records|entry|entries|byte|bytes|kb|mb|gb|tb|second|seconds|minute|minutes|hour|hours|day|days|time|times|page|pages|%)(?:$|[\s\u00a0.,!?%])/i;
const MANUAL_COUNT_UNIT_CJK_PATTERN = /[个件条份次人项页张秒分小时天万亿％%]/u;
const CSS_LAYOUT_PROPERTY_NAMES = new Set([
  'bottom',
  'height',
  'left',
  'right',
  'top',
  'transform',
  'width',
]);

/** Return a stable repository-relative path when possible so allowlists survive worktree changes. */
function stableFilePath(filePath, rootDir) {
  const relative = path.relative(rootDir, filePath).split(path.sep).join('/');
  return relative.startsWith('../') ? path.resolve(filePath) : relative;
}

/** Recognize exact protocol or enum tokens that are data values rather than product prose. */
function isTechnicalToken(value) {
  const text = String(value).trim();
  return (
    TECHNICAL_TOKEN_SET.has(text) ||
    text === 'v' ||
    /^v(?:\s*(?:→|->|[-–—])\s*v)?$/.test(text) ||
    /^(?:[A-Z]+[_-]\d+|(?:HTTP|HTTPS)[:/][A-Z0-9._/-]+)$/.test(text)
  );
}

/** Determine whether a literal contains human-facing product prose rather than raw technical data. */
function hasVisibleProse(value) {
  const text = String(value).trim();
  return /\p{L}/u.test(text) && !isTechnicalToken(text);
}

/** Extract a static string from literal syntax without accepting interpolated templates. */
function staticString(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** Unwrap expression-only TypeScript syntax before applying a narrow locale/dataflow rule. */
function unwrapExpression(node) {
  let current = node;
  while (
    current && (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    )
  ) current = current.expression;
  return current;
}

/** Return a literal property name without treating dynamic keys as locale declarations. */
function staticLocalePropertyName(node) {
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  }
  return undefined;
}

/** Distinguish natural-language locale copy from raw identifiers and exact protocol tokens. */
function isNaturalLocaleCopyText(value) {
  const text = String(value).trim();
  if (SUPPORTED_LOCALE_TAGS.has(text) || !hasVisibleProse(text) || isTechnicalToken(text)) return false;
  // Lowercase identifier-shaped values are commonly statuses, enum members, or raw IDs.
  if (/^[a-z][a-z0-9_.:-]*$/.test(text)) return false;
  return true;
}

/** Collect only literal product text nested inside a proven locale-copy object. */
function localeCopyTextSources(node, sourceFile, depth = 0) {
  if (!node || depth > 8) return [];
  const current = unwrapExpression(node);
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return isNaturalLocaleCopyText(current.text) ? [current] : [];
  }
  if (ts.isTemplateExpression(current)) {
    const staticText = [current.head.text, ...current.templateSpans.map((span) => span.literal.text)].join('');
    return isNaturalLocaleCopyText(staticText) ? [current] : [];
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.flatMap((property) => (
      ts.isPropertyAssignment(property)
        ? localeCopyTextSources(property.initializer, sourceFile, depth + 1)
        : []
    ));
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element) => localeCopyTextSources(element, sourceFile, depth + 1));
  }
  if (ts.isConditionalExpression(current)) {
    return [
      ...localeCopyTextSources(current.whenTrue, sourceFile, depth + 1),
      ...localeCopyTextSources(current.whenFalse, sourceFile, depth + 1),
    ];
  }
  return [];
}

/** Confirm an object literal has both supported locale keys before inspecting its nested values. */
function isLocaleCopyObject(node) {
  const current = unwrapExpression(node);
  if (!ts.isObjectLiteralExpression(current)) return false;
  const localeKeys = new Set(
    current.properties
      .map(staticLocalePropertyName)
      .filter((name) => SUPPORTED_LOCALE_TAGS.has(name)),
  );
  return localeKeys.size === SUPPORTED_LOCALE_TAGS.size;
}

/** Inspect a *_COPY declaration while leaving raw API objects and non-locale maps untouched. */
function inspectLocaleCopyDeclaration(node, sourceFile, report) {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
  if (!LOCALE_COPY_NAME_PATTERN.test(node.name.text) || !isLocaleCopyObject(node.initializer)) return;
  const current = unwrapExpression(node.initializer);
  if (!ts.isObjectLiteralExpression(current)) return;
  const sources = current.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [];
    const name = staticLocalePropertyName(property);
    return SUPPORTED_LOCALE_TAGS.has(name)
      ? localeCopyTextSources(property.initializer, sourceFile)
      : [];
  });
  const source = [...new Set(sources)][0];
  if (source) report(source, 'typescript.localeCopy', 'locale copy objects must use semantic message IDs instead of inline product prose');
}

/** Recognize explicit locale comparisons or locale-named variables without matching arbitrary variants. */
function isLocaleCondition(node) {
  const current = unwrapExpression(node);
  if (!current) return false;
  if (ts.isBinaryExpression(current)) {
    const operator = current.operatorToken.kind;
    const comparison = [
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(operator);
    if (comparison) {
      const left = staticString(current.left);
      const right = staticString(current.right);
      if (SUPPORTED_LOCALE_TAGS.has(left) || SUPPORTED_LOCALE_TAGS.has(right)) return true;
    }
    return [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken]
      .includes(operator) && (isLocaleCondition(current.left) || isLocaleCondition(current.right));
  }
  if (ts.isPrefixUnaryExpression(current)) return isLocaleCondition(current.operand);
  if (ts.isIdentifier(current)) return /(?:^|_)(?:locale|language|lang|uiLocale|appLocale|currentLocale)$/i.test(current.text);
  if (ts.isPropertyAccessExpression(current)) return /(?:locale|language|lang)$/i.test(current.name.text);
  return false;
}

/** Reject natural-language branches selected by locale while allowing translated/raw/technical branches. */
function inspectLocaleBranch(node, sourceFile, checker, report) {
  let sources = [];
  if (ts.isConditionalExpression(node) && isLocaleCondition(node.condition)) {
    sources = [
      ...localeCopyTextSources(node.whenTrue, sourceFile),
      ...localeCopyTextSources(node.whenFalse, sourceFile),
    ];
  } else if (ts.isIfStatement(node) && isLocaleCondition(node.expression)) {
    const branchSources = (statement) => {
      if (ts.isBlock(statement)) {
        return statement.statements.flatMap((child) => (
          ts.isReturnStatement(child) && child.expression
            ? localeCopyTextSources(child.expression, sourceFile)
            : []
        ));
      }
      return ts.isReturnStatement(statement) && statement.expression
        ? localeCopyTextSources(statement.expression, sourceFile)
        : [];
    };
    sources = [
      ...branchSources(node.thenStatement),
      ...(node.elseStatement ? branchSources(node.elseStatement) : []),
    ];
  } else if (ts.isSwitchStatement(node) && isLocaleCondition(node.expression)) {
    sources = node.caseBlock.clauses.flatMap((clause) => clause.statements.flatMap((statement) => (
      ts.isReturnStatement(statement) && statement.expression
        ? localeCopyTextSources(statement.expression, sourceFile)
        : []
    )));
  } else {
    return;
  }
  for (const source of [...new Set(sources)]) {
    report(source, 'typescript.localeCopy', 'locale branches must select semantic messages, not inline product prose');
  }
}

/** Return true when an expression is statically or nominally numeric for unit/plural detection. */
function isNumericLikeExpression(node, checker, depth = 0) {
  if (!node || depth > 6) return false;
  const current = unwrapExpression(node);
  const type = checker?.getTypeAtLocation(current);
  if (type?.flags & ts.TypeFlags.NumberLike) return true;
  if (ts.isNumericLiteral(current)) return true;
  if (ts.isPrefixUnaryExpression(current)) return isNumericLikeExpression(current.operand, checker, depth + 1);
  if (ts.isIdentifier(current)) return /(?:^|_)(?:count|total|amount|number|size|bytes?|percent|percentage|index|page|limit|offset|duration|seconds?|minutes?|hours?)$/i.test(current.text);
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return isNumericLikeExpression(current.expression, checker, depth + 1);
  }
  if (ts.isCallExpression(current)) {
    return current.arguments.some((argument) => isNumericLikeExpression(argument, checker, depth + 1));
  }
  if (ts.isBinaryExpression(current)) {
    return [
      ts.SyntaxKind.AsteriskToken,
      ts.SyntaxKind.SlashToken,
      ts.SyntaxKind.PercentToken,
      ts.SyntaxKind.MinusToken,
    ].includes(current.operatorToken.kind) && (
      isNumericLikeExpression(current.left, checker, depth + 1) ||
      isNumericLikeExpression(current.right, checker, depth + 1)
    );
  }
  return false;
}

/** Match only common count/unit suffixes so technical enums and arbitrary raw prose are not swept in. */
function isManualCountUnitText(value) {
  const text = String(value).trim();
  return MANUAL_COUNT_UNIT_PATTERN.test(text) || MANUAL_COUNT_UNIT_CJK_PATTERN.test(text);
}

/** Flatten one plus expression into operands while preserving a bounded AST interpretation. */
function plusOperands(node) {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) return [...plusOperands(node.left), ...plusOperands(node.right)];
  return [node];
}

/** Detect numeric expressions manually joined with a unit or plural suffix. */
function isManualUnitConcatenation(node, checker) {
  const operands = plusOperands(node);
  if (operands.length < 2) return false;
  const hasUnit = operands.some((operand) => {
    const text = staticString(operand);
    return text !== undefined && isManualCountUnitText(text);
  });
  const hasNumeric = operands.some((operand) => staticString(operand) === undefined && isNumericLikeExpression(operand, checker));
  return hasUnit && hasNumeric;
}

/** Detect templates that manually append a count/unit label instead of using an ICU message. */
function isManualUnitTemplate(node, checker) {
  const staticText = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('');
  return isManualCountUnitText(staticText) && node.templateSpans.some(
    (span) => isNumericLikeExpression(span.expression, checker),
  );
}

/** Detect count===1 style plural branches while leaving ordinary locale/raw conditionals alone. */
function isManualPluralConditional(node, checker) {
  if (!ts.isConditionalExpression(node) || !ts.isBinaryExpression(node.condition)) return false;
  const operator = node.condition.operatorToken.kind;
  if (![ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(operator)) return false;
  const left = node.condition.left;
  const right = node.condition.right;
  const numericComparison = (ts.isNumericLiteral(left) && isNumericLikeExpression(right, checker)) ||
    (ts.isNumericLiteral(right) && isNumericLikeExpression(left, checker));
  if (!numericComparison) return false;
  const branchText = [node.whenTrue, node.whenFalse].map(staticString);
  return branchText.some((text) => text !== undefined && isManualCountUnitText(text));
}

/** Keep CSS dimensions and transforms outside product-copy formatting enforcement. */
function isCssLayoutValue(node) {
  let current = node.parent;
  while (current) {
    if (ts.isPropertyAssignment(current)) {
      const name = staticLocalePropertyName(current);
      if (CSS_LAYOUT_PROPERTY_NAMES.has(name)) return true;
    }
    if (ts.isVariableDeclaration(current)) {
      const name = current.name.getText();
      if (/^(?:width|height|top|left|right|bottom|offset|transform)$/i.test(name)) return true;
      if (/\b(?:width|height|top|left|right|bottom|offset|transform)\b/i.test(name)) return true;
    }
    current = current.parent;
  }
  return false;
}

/** Inspect hand-built plural/unit output without flagging Intl formatters, raw values, or protocols. */
function inspectManualLocaleFormatting(node, sourceFile, checker, report) {
  if (isCssLayoutValue(node)) return;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const parent = node.parent;
    if (
      !(
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) &&
      isManualUnitConcatenation(node, checker)
    ) {
      report(node, 'typescript.manualLocaleFormatting', 'counts and units must use locale-aware ICU/Intl formatting');
    }
  }
  const templateParent = node.parent;
  const nestedTemplate = ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? (() => {
      let current = templateParent;
      while (current) {
        if (ts.isTemplateExpression(current)) return true;
        current = current.parent;
      }
      return false;
    })()
    : false;
  if (ts.isTemplateExpression(node) && !nestedTemplate && isManualUnitTemplate(node, checker)) {
    report(node, 'typescript.manualLocaleFormatting', 'counts and units must use locale-aware ICU/Intl formatting');
  }
  if (ts.isConditionalExpression(node) && isManualPluralConditional(node, checker)) {
    report(node, 'typescript.manualLocaleFormatting', 'plural branches must use locale-aware ICU formatting');
  }
}

/** Return a source expression's dotted textual name for narrowly scoped sink matching. */
function expressionName(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/g, '');
}

/** Resolve a local identifier's initializer for narrow dynamic-key analysis without global flow. */
function localInitializer(identifier, sourceFile) {
  let initializer;
  const visit = (node) => {
    if (
      initializer === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === identifier.text
    ) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return initializer;
}

/** Resolve only same-file variable initializers through the TypeScript symbol table when available. */
function localVariableInitializers(identifier, sourceFile, checker) {
  const symbol = checker?.getSymbolAtLocation(identifier);
  const declarations = symbol?.declarations ?? [];
  const symbolInitializers = declarations
    .filter((declaration) =>
      ts.isVariableDeclaration(declaration) && declaration.initializer,
    )
    .map((declaration) => declaration.initializer)
    .filter((initializer) => initializer.getSourceFile() === sourceFile);
  if (symbolInitializers.length > 0) return symbolInitializers;
  if (checker) return [];
  const fallback = localInitializer(identifier, sourceFile);
  return fallback ? [fallback] : [];
}

/** Return true only for a MessageId alias or a semantic string-literal union proven by TypeScript. */
function isValidatedMessageIdType(type) {
  if (!type) return false;
  if (type.aliasSymbol?.name === 'MessageId' || type.symbol?.name === 'MessageId') return true;
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return SEMANTIC_ID_PATTERN.test(type.value);
  }
  return type.isUnion() && type.types.length > 0 && type.types.every(isValidatedMessageIdType);
}

/** Return true when a declaration's explicit type syntax references the governed MessageId alias. */
function declarationUsesMessageId(declaration) {
  if (!declaration?.type) return false;
  let found = false;
  /** Walk only the declaration's type node and stop after the exact alias is found. */
  const visit = (node) => {
    if (found) return;
    if (ts.isTypeReferenceNode(node) && node.typeName.getText() === 'MessageId') {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.type);
  return found;
}

/** Resolve the declaration symbol for an identifier or property-access message-ID candidate. */
function expressionSymbol(node, checker) {
  if (!node || !checker) return undefined;
  if (ts.isPropertyAccessExpression(node)) return checker.getSymbolAtLocation(node.name);
  if (ts.isIdentifier(node)) return checker.getSymbolAtLocation(node);
  return undefined;
}

/** Determine whether a call is a fail-closed guard whose predicate narrows to MessageDescriptor. */
function isFailClosedDescriptorGuard(call, checker) {
  if (!ts.isCallExpression(call) || !ts.isPrefixUnaryExpression(call.parent)) return false;
  if (call.parent.operator !== ts.SyntaxKind.ExclamationToken) return false;
  const ifStatement = call.parent.parent;
  if (!ts.isIfStatement(ifStatement) || ifStatement.expression !== call.parent) return false;
  const exits = ts.isReturnStatement(ifStatement.thenStatement) ||
    ts.isThrowStatement(ifStatement.thenStatement) ||
    (ts.isBlock(ifStatement.thenStatement) && ifStatement.thenStatement.statements.some(
      (statement) => ts.isReturnStatement(statement) || ts.isThrowStatement(statement),
    ));
  if (!exits) return false;

  const symbol = checker.getSymbolAtLocation(call.expression);
  return Boolean(symbol?.declarations?.some((declaration) =>
    ts.isFunctionLike(declaration) &&
    declaration.type &&
    ts.isTypePredicateNode(declaration.type) &&
    declaration.type.type.getText().endsWith('MessageDescriptor'),
  ));
}

/** Verify a property access follows a prior fail-closed MessageDescriptor guard in its function. */
function hasDescriptorGuard(node, sourceFile, checker) {
  if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return false;
  const subjectName = node.expression.text;
  let functionLike = node.parent;
  while (functionLike && !ts.isFunctionLike(functionLike)) functionLike = functionLike.parent;
  if (!functionLike?.body) return false;

  // Scan only earlier statements in the containing function for a fail-closed predicate guard.
  let validated = false;
  /** Stop at the guarded sink and accept only a matching prior type-predicate call. */
  const visit = (candidate) => {
    if (validated || candidate.getStart(sourceFile) >= node.getStart(sourceFile)) return;
    if (
      ts.isCallExpression(candidate) &&
      candidate.arguments[0] &&
      ts.isIdentifier(candidate.arguments[0]) &&
      candidate.arguments[0].text === subjectName &&
      isFailClosedDescriptorGuard(candidate, checker)
    ) {
      validated = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(functionLike.body);
  return validated;
}

/** Validate an indirect message-ID expression through type or explicit declaration provenance. */
function isValidatedMessageIdExpression(node, sourceFile, checker) {
  if (!node || !checker) return false;
  if (isValidatedMessageIdType(checker.getTypeAtLocation(node))) return true;
  const symbol = expressionSymbol(node, checker);
  if (symbol?.declarations?.some(declarationUsesMessageId)) return true;
  if (ts.isElementAccessExpression(node)) {
    const initializers = localElementInitializers(node, sourceFile, checker);
    if (
      initializers.length > 0 &&
      initializers.every((initializer) => {
        const value = staticString(initializer);
        return value !== undefined && SEMANTIC_ID_PATTERN.test(value);
      })
    ) return true;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const initializers = localPropertyInitializers(node.expression, node.name.text, sourceFile, checker);
    if (
      initializers.length > 0 &&
      initializers.every((initializer) => {
        const value = staticString(initializer);
        return value !== undefined && SEMANTIC_ID_PATTERN.test(value);
      })
    ) return true;
  }
  return hasDescriptorGuard(node, sourceFile, checker);
}

/** Resolve and validate the id property of a typed descriptor expression. */
function isValidatedMessageDescriptor(node, checker) {
  if (!node || !checker) return false;
  const descriptorType = checker.getTypeAtLocation(node);
  const idSymbol = descriptorType.getProperty('id');
  if (!idSymbol) return false;
  return isValidatedMessageIdType(checker.getTypeOfSymbolAtLocation(idSymbol, node)) ||
    idSymbol.declarations?.some(declarationUsesMessageId) === true;
}

/** Create one actionable diagnostic with line and exact source evidence for fingerprinting. */
function nodeDiagnostic(rule, filePath, sourceFile, node, message, rootDir) {
  const start = node.getStart(sourceFile);
  const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
  const diagnostic = {
    ...createDiagnostic(rule, stableFilePath(filePath, rootDir), message),
    line,
    source: node.getText(sourceFile).trim(),
  };
  if (typeof node.kind === 'number') diagnostic.astKind = ts.SyntaxKind[node.kind];
  return diagnostic;
}

/** Hash the rule, file, and exact AST evidence used by one compatibility exception. */
function fingerprintDiagnostic(diagnostic) {
  const evidence = [diagnostic.rule, diagnostic.file, diagnostic.source ?? ''].join('\0');
  return `sha256:${crypto.createHash('sha256').update(evidence).digest('hex')}`;
}

/** Check whether one exact, owned, unexpired compatibility entry suppresses a diagnostic. */
function isAllowlisted(diagnostic, allowlistEntries, currentDate) {
  const fingerprint = fingerprintDiagnostic(diagnostic);
  return allowlistEntries.some(
    (entry) =>
      entry.file === diagnostic.file &&
      entry.rule === diagnostic.rule &&
      entry.fingerprint === fingerprint &&
      typeof entry.owner === 'string' &&
      entry.owner.trim() !== '' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim() !== '' &&
      /^\d{4}-\d{2}-\d{2}$/.test(entry.expires) &&
      entry.expires >= currentDate,
  );
}

/** Detect hardcoded product prose inside a local postMessage payload without inspecting raw fields. */
function inspectPostMessagePayload(payload, sourceFile, checker, report) {
  if (!payload) return;
  const payloadObjects = ts.isObjectLiteralExpression(payload)
    ? [payload]
    : localObjectLiterals(payload, sourceFile, new Set(), checker);
  for (const payloadObject of payloadObjects) {
    for (const property of payloadObject.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name && staticString(property.name);
      const identifierName = ts.isIdentifier(property.name) ? property.name.text : undefined;
      const fieldName = name ?? identifierName;
      if (!fieldName || !POST_MESSAGE_TEXT_FIELDS.has(fieldName)) continue;
      const sources = visibleExpressionSources(property.initializer, sourceFile, checker);
      for (const source of sources) {
        report(
          source,
          'typescript.hardcodedPostMessage',
          `postMessage product field ${fieldName} must use a semantic descriptor/code`,
        );
      }
    }
  }
}

/** Return the property name for one static property or element access expression. */
function staticPropertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    return node.argumentExpression ? staticString(node.argumentExpression) : undefined;
  }
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  }
  return undefined;
}

/** Return the root identifier and whether an access chain crosses the canonical event data field. */
function accessChainRoot(node) {
  let current = node;
  let crossesData = false;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const propertyName = staticPropertyName(current);
    if (propertyName === 'data') crossesData = true;
    current = current.expression;
  }
  return {
    crossesData,
    root: ts.isIdentifier(current) ? current : undefined,
  };
}

/** Collect TypeScript's nominal names for an expression without treating arbitrary strings as trace types. */
function expressionTypeNames(node, checker) {
  if (!checker || !node) return [];
  const type = checker.getTypeAtLocation(node);
  const names = new Set();
  // Step 1: collect aliases and symbols; step 2: recurse through unions for imported contracts.
  const collect = (candidate) => {
    if (!candidate) return;
    if (candidate.aliasSymbol?.name) names.add(String(candidate.aliasSymbol.name));
    if (candidate.symbol?.name) names.add(String(candidate.symbol.name));
    if (candidate.isUnion?.()) candidate.types.forEach(collect);
  };
  collect(type);
  return [...names];
}

/** Identify a typed trace/event carrier while keeping ordinary user and agent content outside the rule. */
function isTraceCarrierExpression(node, checker) {
  const { crossesData, root } = accessChainRoot(node);
  const typeNames = new Set([
    ...expressionTypeNames(root, checker),
    ...expressionTypeNames(node, checker),
  ]);
  if ([...typeNames].some((name) => TRACE_TYPE_NAME_PATTERN.test(name))) return true;
  if (!root) return false;
  if (['line', 'trace', 'traceLine'].includes(root.text)) return true;
  return crossesData && ['event', 'item', 'streamEvent', 'traceEvent'].includes(root.text);
}

/** Return true for the two sanctioned routes from backend event data to product chrome. */
function isAllowedTraceExpression(node, sourceFile) {
  if (!ts.isCallExpression(node)) return false;
  const callee = expressionName(node.expression, sourceFile);
  const calleeParts = callee.split('.');
  const calleeName = calleeParts[calleeParts.length - 1];
  return callee === 'backendEventMessage'
    || callee.endsWith('.backendEventMessage')
    || callee === 't'
    || callee.endsWith('.t')
    || callee.endsWith('.formatMessage')
    || TRACE_SAFE_SINK_NAMES.has(calleeName);
}

/** Return the nearest containing function-like declaration without crossing a nested function. */
function containingFunction(node) {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  return current;
}

/** Determine whether one AST subtree contains a particular node identity. */
function containsNode(root, target) {
  if (!root || !target) return false;
  if (root === target) return true;
  let found = false;
  /** Stop walking once the target identity is found. */
  const visit = (node) => {
    if (found) return;
    if (node === target) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Find same-function variable declarations by name while excluding nested function scopes. */
function localVariableDeclarations(functionLike, name) {
  if (!functionLike?.body) return [];
  const declarations = [];
  /** Collect declarations in the current function body only. */
  const visit = (node) => {
    if (node !== functionLike.body && ts.isFunctionLike(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(functionLike.body);
  return declarations;
}

/** Confirm that one function projects the accumulator through the raw output-aware trace sink. */
function hasRawTraceSinkProjection(functionLike, sourceFile) {
  if (!functionLike?.body) return false;
  let matched = false;
  // Step 1: locate the exact upsert call; step 2: require the output-aware detail projection.
  /** Inspect only direct upsertVisibleTraceLine object payloads in this function. */
  const visit = (node) => {
    if (matched) return;
    if (node !== functionLike.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = expressionName(node.expression, sourceFile);
      const calleeParts = callee.split('.');
      if (calleeParts[calleeParts.length - 1] === 'upsertVisibleTraceLine') {
        const payload = node.arguments[0];
        if (payload && ts.isObjectLiteralExpression(payload)) {
          matched = payload.properties.some((property) => {
            if (!ts.isPropertyAssignment(property) || staticPropertyName(property) !== 'detail') {
              return false;
            }
            const text = property.initializer.getText(sourceFile);
            return text.includes('outputInfo.output') && text.includes('detail');
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(functionLike.body);
  return matched;
}

/** Match the narrowly bounded stdout/stderr accumulator that is converted by generalSkillTraceOutput. */
function isRawTraceAccumulatorAccess(node, sourceFile) {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'detail') return false;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'existing') return false;
  const functionLike = containingFunction(node);
  if (!functionLike) return false;

  // Step 1: prove existing.detail enters previousOutput and then detail.
  const previousOutput = localVariableDeclarations(functionLike, 'previousOutput')
    .find((declaration) => declaration.initializer && containsNode(declaration.initializer, node));
  if (!previousOutput?.initializer) return false;
  const detail = localVariableDeclarations(functionLike, 'detail')
    .find((declaration) => declaration.initializer &&
      declaration.initializer.getStart(sourceFile) > previousOutput.getStart(sourceFile) &&
      declaration.initializer.getText(sourceFile).includes('previousOutput'));
  if (!detail) return false;

  const outputInfo = localVariableDeclarations(functionLike, 'outputInfo')
    .find((declaration) => declaration.initializer &&
      declaration.initializer.getText(sourceFile).includes('generalSkillTraceOutput'));
  if (!outputInfo) return false;

  // Step 2: prove the same function sends the value through the raw-output-aware trace sink.
  return hasRawTraceSinkProjection(functionLike, sourceFile);
}

/** Resolve backend trace product fields through bounded local aliases, preserving raw payload boundaries. */
function traceProductExpressionSources(node, sourceFile, checker, visited = new Set(), depth = 0) {
  if (!node || depth > 8 || visited.has(node)) return [];
  visited.add(node);
  // Step 1: stop at sanctioned/raw boundaries; step 2: follow only bounded local dataflow.
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return traceProductExpressionSources(node.expression, sourceFile, checker, visited, depth + 1);
  }
  if (isAllowedTraceExpression(node, sourceFile)) return [];
  if (ts.isIdentifier(node)) {
    return uniqueExpressionSources(
      localVariableInitializers(node, sourceFile, checker).flatMap((initializer) =>
        traceProductExpressionSources(initializer, sourceFile, checker, visited, depth + 1),
      ),
    );
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const propertyName = staticPropertyName(node);
    if (TRACE_RAW_FIELDS.has(propertyName)) return [];
    if (isRawTraceAccumulatorAccess(node, sourceFile)) return [];
    if (TRACE_PRODUCT_TEXT_FIELDS.has(propertyName) && isTraceCarrierExpression(node, checker)) {
      return [node];
    }
    if (ts.isPropertyAccessExpression(node)) {
      return uniqueExpressionSources(
        [
          ...localPropertyInitializers(node.expression, node.name.text, sourceFile, checker),
          ...configuredJsxPropertyInitializers(node, sourceFile),
        ].flatMap((initializer) =>
          traceProductExpressionSources(initializer, sourceFile, checker, visited, depth + 1),
        ),
      );
    }
    return uniqueExpressionSources(
      localElementInitializers(node, sourceFile, checker).flatMap((initializer) =>
        traceProductExpressionSources(initializer, sourceFile, checker, visited, depth + 1),
      ),
    );
  }
  if (ts.isTemplateExpression(node)) {
    const sources = node.templateSpans.flatMap((span) =>
      traceProductExpressionSources(span.expression, sourceFile, checker, visited, depth + 1),
    );
    return uniqueExpressionSources(sources);
  }
  if (ts.isBinaryExpression(node)) {
    const sources = [
      ...traceProductExpressionSources(node.left, sourceFile, checker, visited, depth + 1),
      ...traceProductExpressionSources(node.right, sourceFile, checker, visited, depth + 1),
    ];
    return uniqueExpressionSources(sources);
  }
  if (ts.isConditionalExpression(node)) {
    const sources = [
      ...traceProductExpressionSources(node.whenTrue, sourceFile, checker, visited, depth + 1),
      ...traceProductExpressionSources(node.whenFalse, sourceFile, checker, visited, depth + 1),
    ];
    return uniqueExpressionSources(sources);
  }
  if (ts.isCallExpression(node)) {
    return uniqueExpressionSources(
      localCallReturnExpressions(node, sourceFile, checker).flatMap((returned) =>
        traceProductExpressionSources(returned, sourceFile, checker, visited, depth + 1),
      ),
    );
  }
  return [];
}

/** Inspect the exact trace-line constructor sink while leaving user, agent, tool, and raw output fields untouched. */
function inspectTraceSinkPayload(payload, sourceFile, checker, report) {
  if (!payload) return;
  // Step 1: resolve only one exact trace sink payload; step 2: inspect governed product fields.
  const payloadObjects = ts.isObjectLiteralExpression(payload)
    ? [payload]
    : localObjectLiterals(payload, sourceFile, new Set(), checker);
  for (const payloadObject of payloadObjects) {
    for (const property of payloadObject.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const propertyName = staticPropertyName(property);
      if (!TRACE_PRODUCT_TEXT_FIELDS.has(propertyName)) continue;
      for (const source of traceProductExpressionSources(property.initializer, sourceFile, checker)) {
        report(
          source,
          'typescript.hardcodedTraceText',
          `trace product field ${propertyName} must use backendEventMessage or a semantic message ID`,
        );
      }
    }
  }
}

/** Do not treat an event field used only as the left side of a JSX short-circuit as rendered text. */
function isJsxTraceControlExpression(node) {
  if (!ts.isBinaryExpression(node)) return false;
  if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return false;
  let right = node.right;
  while (ts.isParenthesizedExpression(right) || ts.isAsExpression(right)) right = right.expression;
  return ts.isJsxElement(right) || ts.isJsxFragment(right);
}

/** Validate one formatMessage/t call so only literals or TypeScript-proven MessageIds reach catalogs. */
function inspectMessageCall(node, sourceFile, checker, report) {
  const callee = expressionName(node.expression, sourceFile);
  if (callee.endsWith('.formatMessage')) {
    const descriptor = node.arguments[0];
    if (!descriptor) return;
    if (!ts.isObjectLiteralExpression(descriptor)) {
      if (!isValidatedMessageDescriptor(descriptor, checker)) {
        report(descriptor, 'typescript.dynamicMessageId', 'formatMessage requires a typed semantic descriptor');
      }
      return;
    }
    const idProperty = descriptor.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ((ts.isIdentifier(property.name) && property.name.text === 'id') ||
          (ts.isStringLiteral(property.name) && property.name.text === 'id')),
    );
    if (!idProperty || !ts.isPropertyAssignment(idProperty)) {
      report(descriptor, 'typescript.dynamicMessageId', 'formatMessage requires a static semantic ID');
      return;
    }
    const messageIdNode = idProperty.initializer;
    const messageId = staticString(messageIdNode);
    if (messageId !== undefined && !SEMANTIC_ID_PATTERN.test(messageId)) {
      report(
        messageIdNode,
        'typescript.hardcodedSourceKey',
        'message ID is prose-shaped instead of a semantic identifier',
      );
    } else if (
      messageId === undefined &&
      !isValidatedMessageIdExpression(messageIdNode, sourceFile, checker)
    ) {
      report(messageIdNode, 'typescript.dynamicMessageId', 'message IDs must retain the MessageId type');
    }
    return;
  }

  if (callee === 't' || callee.endsWith('.t')) {
    const messageIdNode = node.arguments[0];
    const messageId = messageIdNode && staticString(messageIdNode);
    if (messageId !== undefined && !SEMANTIC_ID_PATTERN.test(messageId)) {
      report(
        messageIdNode,
        'typescript.hardcodedSourceKey',
        'natural-language source strings cannot be translation keys',
      );
    } else if (
      messageId === undefined &&
      messageIdNode &&
      !isValidatedMessageIdExpression(messageIdNode, sourceFile, checker)
    ) {
      report(node, 'typescript.dynamicMessageId', 'legacy translation calls cannot build dynamic IDs');
    }
  }
}

/** Report local product sources flowing into one non-DOM message sink. */
function inspectCallMessageSources(node, rule, message, sourceFile, checker, report) {
  const argument = node.arguments[0];
  if (!argument) return;
  for (const source of visibleExpressionSources(argument, sourceFile, checker)) {
    report(source, rule, message);
  }
}

/** Inspect one call expression for non-DOM sinks and fixed locale literals. */
function inspectCallExpression(node, sourceFile, checker, report) {
  const callee = expressionName(node.expression, sourceFile);
  inspectMessageCall(node, sourceFile, checker, report);

  if (/^(?:window\.)?(?:alert|confirm|prompt)$/.test(callee)) {
    inspectCallMessageSources(
      node,
      'typescript.hardcodedNativeDialog',
      'native dialog text must come from a semantic descriptor',
      sourceFile,
      checker,
      report,
    );
  }
  if (/(?:^|\.)(?:toast|notify)\.(?:success|error|warning|info|loading)$/.test(callee)) {
    inspectCallMessageSources(
      node,
      'typescript.hardcodedToast',
      'toast text must come from a semantic descriptor',
      sourceFile,
      checker,
      report,
    );
  }
  if (/clipboard.*(?:notice|message|status)/i.test(callee)) {
    inspectCallMessageSources(
      node,
      'typescript.hardcodedClipboardNotice',
      'clipboard feedback text must come from a semantic descriptor',
      sourceFile,
      checker,
      report,
    );
  }
  if (callee.endsWith('postMessage')) {
    inspectPostMessagePayload(node.arguments[0], sourceFile, checker, report);
  }
  const calleeParts = callee.split('.');
  if (TRACE_SINK_NAMES.has(calleeParts[calleeParts.length - 1])) {
    inspectTraceSinkPayload(node.arguments[0], sourceFile, checker, report);
  }

  const localeCall =
    /^(?:Intl\.)?(?:DateTimeFormat|NumberFormat|PluralRules|Collator|RelativeTimeFormat)$/.test(
      callee,
    ) || /\.toLocale(?:String|DateString|TimeString)$/.test(callee);
  if (localeCall) {
    for (const source of visibleExpressionSources(node.arguments[0], sourceFile, checker)) {
      report(
        source,
        'typescript.fixedLocale',
        'business code must format with the resolved locale instead of a fixed locale literal',
      );
    }
  }
}

/** Detect JSX text explicitly owned by code/raw-source markup rather than FirmDeck product chrome. */
function isRawJsxText(node) {
  let current = node.parent;
  while (current) {
    if (ts.isJsxElement(current)) {
      const opening = current.openingElement;
      const tagName = opening.tagName.getText();
      if (
        ['code', 'kbd', 'pre', 'samp'].includes(tagName) ||
        tagName.endsWith('RawContent') ||
        tagName.endsWith('RawIdentifier')
      ) {
        return true;
      }
      const attributes = new Map(
        opening.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((attribute) => [
            attribute.name.getText(),
            attribute.initializer && ts.isStringLiteral(attribute.initializer)
              ? attribute.initializer.text
              : '',
          ]),
      );
      if (attributes.get('translate') === 'no' && attributes.has('data-i18n-raw-kind')) return true;
    }
    current = current.parent;
  }
  return false;
}

/** Return the smallest stable expression node that embeds visible product-authored prose. */
function visibleExpressionEvidence(node) {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return visibleExpressionEvidence(node.expression);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return hasVisibleProse(node.text) ? node : undefined;
  }
  if (ts.isTemplateExpression(node)) {
    const staticText = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('');
    return hasVisibleProse(staticText) ? node : undefined;
  }
  if (ts.isConditionalExpression(node)) {
    return visibleExpressionEvidence(node.whenTrue) || visibleExpressionEvidence(node.whenFalse)
      ? node
      : undefined;
  }
  if (ts.isBinaryExpression(node)) {
    return visibleExpressionEvidence(node.left) || visibleExpressionEvidence(node.right)
      ? node
      : undefined;
  }
  return undefined;
}

/** Resolve locally configured object literals feeding a bounded callback or property expression. */
function localObjectLiterals(expression, sourceFile, visited = new Set(), checker) {
  if (!expression || visited.has(expression)) return [];
  visited.add(expression);
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return localObjectLiterals(expression.expression, sourceFile, visited, checker);
  }
  if (ts.isIdentifier(expression)) {
    const initializers = localVariableInitializers(expression, sourceFile, checker);
    return initializers.flatMap((initializer) =>
      localObjectLiterals(initializer, sourceFile, visited, checker),
    );
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.filter(ts.isObjectLiteralExpression);
  }
  if (ts.isObjectLiteralExpression(expression)) return [expression];
  if (ts.isPropertyAccessExpression(expression)) {
    return localPropertyInitializers(expression.expression, expression.name.text, sourceFile, checker)
      .flatMap((initializer) => localObjectLiterals(initializer, sourceFile, visited, checker));
  }
  if (ts.isElementAccessExpression(expression)) {
    return localObjectLiterals(expression.expression, sourceFile, visited, checker);
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...localObjectLiterals(expression.whenTrue, sourceFile, visited, checker),
      ...localObjectLiterals(expression.whenFalse, sourceFile, visited, checker),
    ];
  }
  if (ts.isBinaryExpression(expression)) {
    return [
      ...localObjectLiterals(expression.left, sourceFile, visited, checker),
      ...localObjectLiterals(expression.right, sourceFile, visited, checker),
    ];
  }
  return [];
}

/** Resolve object property values from same-file object or array literals without scanning globals. */
function localPropertyInitializers(receiver, propertyName, sourceFile, checker) {
  const objects = localObjectLiterals(receiver, sourceFile, new Set(), checker);
  return objects.flatMap((objectLiteral) => objectLiteral.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [];
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined;
    return name === propertyName ? [property.initializer] : [];
  }));
}

/** Resolve element-access values, conservatively returning all local map entries for a dynamic key. */
function localElementInitializers(access, sourceFile, checker) {
  if (!ts.isElementAccessExpression(access)) return [];
  const key = access.argumentExpression && staticString(access.argumentExpression);
  const objects = localObjectLiterals(access.expression, sourceFile, new Set(), checker);
  return objects.flatMap((objectLiteral) => objectLiteral.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [];
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : ts.isNumericLiteral(property.name) ? property.name.text : undefined;
    return key === undefined || name === key ? [property.initializer] : [];
  }));
}

/** Collect return expressions from one local function while avoiding nested function bodies. */
function localFunctionReturnExpressions(functionLike) {
  if (!functionLike?.body) return [];
  if (!ts.isBlock(functionLike.body)) return [functionLike.body];
  const expressions = [];
  const visit = (node) => {
    if (node !== functionLike.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) expressions.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(functionLike.body);
  return expressions;
}

/** Resolve return expressions for a same-file helper called as a visible product-text expression. */
function localCallReturnExpressions(call, sourceFile, checker) {
  if (!ts.isCallExpression(call)) return [];
  const symbol = checker?.getSymbolAtLocation(call.expression);
  const declarations = symbol?.declarations ?? [];
  return declarations
    .filter((declaration) => declaration.getSourceFile() === sourceFile)
    .flatMap((declaration) => {
      if (ts.isFunctionLike(declaration)) return localFunctionReturnExpressions(declaration);
      if (ts.isVariableDeclaration(declaration)) {
        const initializer = declaration.initializer;
        return initializer && ts.isFunctionLike(initializer)
          ? localFunctionReturnExpressions(initializer)
          : [];
      }
      return [];
    });
}

/** Deduplicate source nodes while preserving the first deterministic source order. */
function uniqueExpressionSources(sources) {
  return [...new Set(sources.filter(Boolean))];
}

/** Resolve local product prose through bounded variables, maps, helpers, templates, and operators. */
function visibleExpressionSources(node, sourceFile, checker, visited = new Set(), depth = 0) {
  if (!node || depth > 8 || visited.has(node)) return [];
  visited.add(node);

  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return visibleExpressionSources(node.expression, sourceFile, checker, visited, depth + 1);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return hasVisibleProse(node.text) ? [node] : [];
  }
  if (ts.isTemplateExpression(node)) {
    const staticText = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('');
    if (hasVisibleProse(staticText)) return [node];
    return uniqueExpressionSources([
      ...node.templateSpans.flatMap((span) =>
        visibleExpressionSources(span.expression, sourceFile, checker, visited, depth + 1),
      ),
    ]);
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const rightSources = visibleExpressionSources(node.right, sourceFile, checker, visited, depth + 1);
      return rightSources.length > 0 ? [node] : [];
    }
    if (![ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
      .includes(node.operatorToken.kind)) return [];
    const sources = uniqueExpressionSources([
      ...visibleExpressionSources(node.left, sourceFile, checker, visited, depth + 1),
      ...visibleExpressionSources(node.right, sourceFile, checker, visited, depth + 1),
    ]);
    return sources.length > 0 ? [node] : [];
  }
  if (ts.isConditionalExpression(node)) {
    const sources = uniqueExpressionSources([
      ...visibleExpressionSources(node.whenTrue, sourceFile, checker, visited, depth + 1),
      ...visibleExpressionSources(node.whenFalse, sourceFile, checker, visited, depth + 1),
    ]);
    return sources.length > 0 ? [node] : [];
  }
  if (ts.isIdentifier(node)) {
    return uniqueExpressionSources(
      localVariableInitializers(node, sourceFile, checker).flatMap((initializer) =>
        visibleExpressionSources(initializer, sourceFile, checker, visited, depth + 1),
      ),
    );
  }
  if (ts.isPropertyAccessExpression(node)) {
    return uniqueExpressionSources(
      [
        ...localPropertyInitializers(node.expression, node.name.text, sourceFile, checker),
        ...configuredJsxPropertyInitializers(node, sourceFile),
      ].flatMap((initializer) =>
        visibleExpressionSources(initializer, sourceFile, checker, visited, depth + 1),
      ),
    );
  }
  if (ts.isElementAccessExpression(node)) {
    return uniqueExpressionSources(
      localElementInitializers(node, sourceFile, checker).flatMap((initializer) =>
        visibleExpressionSources(initializer, sourceFile, checker, visited, depth + 1),
      ),
    );
  }
  if (ts.isCallExpression(node)) {
    return uniqueExpressionSources(
      localCallReturnExpressions(node, sourceFile, checker).flatMap((returned) =>
        visibleExpressionSources(returned, sourceFile, checker, visited, depth + 1),
      ),
    );
  }
  return [];
}

/** Find literal config-property initializers that flow into one direct JSX map property access. */
function configuredJsxPropertyInitializers(access, sourceFile) {
  if (!ts.isIdentifier(access.expression)) return [];
  const receiverName = access.expression.text;
  let current = access.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  if (!current || !current.parameters.some(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === receiverName,
  )) return [];

  const callback = current;
  const mapCall = callback.parent;
  if (
    !ts.isCallExpression(mapCall) ||
    !mapCall.arguments.includes(callback) ||
    !ts.isPropertyAccessExpression(mapCall.expression) ||
    mapCall.expression.name.text !== 'map'
  ) return [];

  const propertyName = access.name.text;
  return localObjectLiterals(mapCall.expression.expression, sourceFile).flatMap((objectLiteral) => {
    const property = objectLiteral.properties.find((candidate) => {
      if (!ts.isPropertyAssignment(candidate)) return false;
      if (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) {
        return candidate.name.text === propertyName;
      }
      return false;
    });
    if (!property || !ts.isPropertyAssignment(property)) return [];
    const value = staticString(property.initializer);
    return value && hasVisibleProse(value) ? [property.initializer] : [];
  });
}

/** Inspect JSX literals, expression attributes, and exact local object-to-label dataflow. */
function inspectJsx(node, sourceFile, checker, report) {
  if (ts.isJsxText(node) && hasVisibleProse(node.text) && !isRawJsxText(node)) {
    report(node, 'typescript.hardcodedJsx', 'JSX product text must use a semantic message ID');
    return;
  }
  if (
    ts.isJsxExpression(node) &&
    (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
    node.expression &&
    !isRawJsxText(node)
  ) {
    const traceSources = isJsxTraceControlExpression(node.expression)
      ? []
      : traceProductExpressionSources(node.expression, sourceFile, checker);
    for (const source of traceSources) {
      report(
        source,
        'typescript.hardcodedTraceText',
        'trace product fields rendered in JSX must use backendEventMessage or a semantic message ID',
      );
    }
    const sources = visibleExpressionSources(node.expression, sourceFile, checker);
    for (const initializer of sources) {
      report(
        initializer,
        'typescript.hardcodedJsx',
        'object-configured JSX product text must use a semantic message ID',
      );
    }
    return;
  }
  if (!ts.isJsxAttribute(node)) return;
  const name = node.name.getText();
  const literalValue = node.initializer && ts.isStringLiteral(node.initializer)
    ? node.initializer.text
    : '';
  const expressionEvidence = node.initializer && ts.isJsxExpression(node.initializer)
    ? visibleExpressionSources(node.initializer.expression, sourceFile, checker)
    : [];
  if (name === 'data-i18n-ignore') {
    report(
      node,
      'typescript.broadIgnore',
      'broad data-i18n-ignore regions are prohibited; mark exact raw content instead',
    );
  }
  if (
    LOCALIZED_ATTRIBUTE_NAMES.has(name) &&
    !isRawJsxText(node) &&
    (hasVisibleProse(literalValue) || expressionEvidence.length > 0)
  ) {
    if (expressionEvidence.length > 0) {
      for (const evidence of expressionEvidence) {
        report(
          evidence,
          'typescript.hardcodedAttribute',
          `${name} product text must use a semantic descriptor`,
        );
      }
    } else {
      report(
        node.initializer,
        'typescript.hardcodedAttribute',
        `${name} product text must use a semantic descriptor`,
      );
    }
  }
  if (name === 'download' && !isRawJsxText(node)) {
    const sources = node.initializer && ts.isJsxExpression(node.initializer)
      ? visibleExpressionSources(node.initializer.expression, sourceFile, checker)
      : [];
    if (hasVisibleProse(literalValue) && sources.length === 0) sources.push(node.initializer);
    for (const source of sources) {
      report(
        source,
        'typescript.hardcodedDownloadName',
        'download product filename must be formatted through the localized sink',
      );
    }
  }
}

/** Inspect assignments for document title and imperative download filename sinks. */
function inspectAssignment(node, sourceFile, checker, report) {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  const left = expressionName(node.left, sourceFile);
  const sources = visibleExpressionSources(node.right, sourceFile, checker);
  const leftParts = left.split('.');
  const phaseOwner = leftParts.length > 1 ? leftParts[leftParts.length - 2] : '';
  if (leftParts[leftParts.length - 1] === 'phase' && /(?:stream|trace)/i.test(phaseOwner)) {
    for (const source of traceProductExpressionSources(node.right, sourceFile, checker)) {
      report(
        source,
        'typescript.hardcodedTraceText',
        'stream trace phase text must use backendEventMessage or a semantic message ID',
      );
    }
  }
  if (sources.length === 0) return;
  if (left === 'document.title') {
    for (const source of sources) {
      report(
        source,
        'typescript.hardcodedDocumentTitle',
        'document.title must use the active UI locale',
      );
    }
  }
  if (left.endsWith('.download')) {
    for (const source of sources) {
      report(
        source,
        'typescript.hardcodedDownloadName',
        'download product filename must use the localized sink',
      );
    }
  }
}

/** Inspect ignore comments and require exact reason, owner, and expiry metadata. */
function inspectIgnoreComments(filePath, sourceFile, report) {
  const pattern = /i18n-ignore-next-line[^\r\n]*/g;
  for (const match of sourceFile.text.matchAll(pattern)) {
    const text = match[0];
    if (
      !/reason:\s*\S/i.test(text) ||
      !/owner:\s*\S/i.test(text) ||
      !/expires:\s*\d{4}-\d{2}-\d{2}/i.test(text)
    ) {
      const start = match.index ?? 0;
      const node = {
        getStart: () => start,
        getText: () => text,
      };
      report(
        node,
        'typescript.invalidIgnore',
        'i18n ignore requires reason, owner, and ISO expiry on the exact next line',
      );
    }
  }
}

/** Parse and check one TypeScript/TSX file, returning unsuppressed structured diagnostics. */
function checkTypeScriptFile(filePath, options) {
  const sourceFile = options.program.getSourceFile(path.resolve(filePath));
  if (!sourceFile) return [];
  const diagnostics = [];
  const reportedEvidence = new Set();
  /** Add one diagnostic per rule and AST position before applying the exact allowlist. */
  const report = (node, rule, message) => {
    const evidenceKey = `${rule}:${node.getStart(sourceFile)}`;
    if (reportedEvidence.has(evidenceKey)) return;
    reportedEvidence.add(evidenceKey);
    diagnostics.push(
      nodeDiagnostic(rule, filePath, sourceFile, node, message, options.rootDir),
    );
  };

  inspectIgnoreComments(filePath, sourceFile, report);
  /** Visit every AST node exactly once and route it to the governed sink inspectors. */
  const visit = (node) => {
    inspectJsx(node, sourceFile, options.checker, report);
    inspectLocaleCopyDeclaration(node, sourceFile, report);
    inspectLocaleBranch(node, sourceFile, options.checker, report);
    inspectManualLocaleFormatting(node, sourceFile, options.checker, report);
    if (ts.isCallExpression(node)) {
      inspectCallExpression(node, sourceFile, options.checker, report);
    }
    inspectAssignment(node, sourceFile, options.checker, report);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return diagnostics.filter(
    (diagnostic) =>
      !isAllowlisted(diagnostic, options.allowlistEntries, options.currentDate),
  );
}

/** Build one read-only TypeScript program so indirect MessageId checks use actual resolved types. */
function createTypeProgram(filePaths, rootDir) {
  // First locate the nearest project config from the checked files, then fall back to the caller root.
  const searchRoots = [path.dirname(filePaths[0]), rootDir, process.cwd()];
  const configPath = searchRoots
    .map((searchRoot) => ts.findConfigFile(searchRoot, fs.existsSync, 'tsconfig.json'))
    .find(Boolean);
  let compilerOptions = {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2020,
  };
  if (configPath) {
    const config = ts.readConfigFile(configPath, fs.readFileSync);
    if (!config.error) {
      compilerOptions = {
        ...ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).options,
        noEmit: true,
        skipLibCheck: true,
      };
    }
  }

  // Then create a single program for deterministic cross-file type resolution without emitting files.
  return ts.createProgram({ rootNames: filePaths.map((filePath) => path.resolve(filePath)), options: compilerOptions });
}

/** Return true for TypeScript paths that are intentionally outside production i18n governance. */
function isExcludedTypeScriptFile(filePath) {
  return /(?:^|[/\\])[^/\\]+\.(?:test|spec)\.tsx?$/.test(filePath) || /\.d\.ts$/.test(filePath);
}

/** Check a deterministic file list with optional exact compatibility fingerprints. */
function checkTypeScriptFiles({
  filePaths,
  allowlistEntries = [],
  rootDir = process.cwd(),
  currentDate = new Date().toISOString().slice(0, 10),
}) {
  const includedFilePaths = [...filePaths].filter((filePath) => !isExcludedTypeScriptFile(filePath)).sort();
  if (includedFilePaths.length === 0) return [];
  const program = createTypeProgram(includedFilePaths, rootDir);
  const checker = program.getTypeChecker();
  return sortDiagnostics(
    includedFilePaths
      .flatMap((filePath) =>
        checkTypeScriptFile(filePath, {
          allowlistEntries,
          checker,
          currentDate,
          program,
          rootDir,
        }),
      ),
  );
}

module.exports = {
  checkTypeScriptFiles,
  fingerprintDiagnostic,
};

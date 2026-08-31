/** Validate semantic message catalogs, ICU structure, locale parity, and source usage. */

const fs = require('node:fs');

const { parse, TYPE } = require('@formatjs/icu-messageformat-parser');
const ts = require('typescript');

const { createDiagnostic, sortDiagnostics } = require('./diagnostics.cjs');

const SEMANTIC_ID_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;

/** Read a flat JSON catalog while preserving duplicate-property evidence hidden by JSON.parse. */
function readCatalog(locale, filePath) {
  const diagnostics = [];
  const sourceText = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.parseJsonText(filePath, sourceText);
  for (const diagnostic of sourceFile.parseDiagnostics) {
    diagnostics.push(
      createDiagnostic(
        'catalog.invalidJson',
        filePath,
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      ),
    );
  }
  if (diagnostics.length > 0) return { locale, messages: {}, diagnostics };

  const statement = sourceFile.statements[0];
  const objectLiteral = statement?.expression;
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) {
    diagnostics.push(
      createDiagnostic('catalog.invalidJson', filePath, 'catalog root must be a JSON object'),
    );
    return { locale, messages: {}, diagnostics };
  }

  const seenIds = new Set();
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) continue;
    const messageId = property.name.text;
    if (seenIds.has(messageId)) {
      diagnostics.push(
        createDiagnostic(
          'catalog.duplicateKey',
          filePath,
          `duplicate message ID in ${locale}`,
          messageId,
        ),
      );
    }
    seenIds.add(messageId);
  }

  let messages;
  try {
    messages = JSON.parse(sourceText);
  } catch (error) {
    diagnostics.push(
      createDiagnostic('catalog.invalidJson', filePath, String(error)),
    );
    return { locale, messages: {}, diagnostics };
  }
  if (
    messages === null ||
    Array.isArray(messages) ||
    typeof messages !== 'object' ||
    Object.values(messages).some((value) => typeof value !== 'string')
  ) {
    diagnostics.push(
      createDiagnostic(
        'catalog.invalidShape',
        filePath,
        'catalog must be a flat object whose values are ICU message strings',
      ),
    );
    return { locale, messages: {}, diagnostics };
  }
  return { locale, messages, diagnostics };
}

/** Record an ICU argument kind once and surface incompatible reuse inside a single message. */
function recordArgument(structure, name, kind) {
  const previous = structure.arguments[name];
  structure.arguments[name] = previous && previous !== kind ? `${previous}|${kind}` : kind;
}

/** Recursively derive named arguments, select semantics, and rich-text tags from one ICU AST. */
function visitIcuElements(elements, structure) {
  for (const element of elements) {
    if (element.type === TYPE.argument) recordArgument(structure, element.value, 'argument');
    if (element.type === TYPE.number) recordArgument(structure, element.value, 'number');
    if (element.type === TYPE.date) recordArgument(structure, element.value, 'date');
    if (element.type === TYPE.time) recordArgument(structure, element.value, 'time');
    if (element.type === TYPE.select) {
      const branches = Object.keys(element.options).sort().join(',');
      recordArgument(structure, element.value, `select:${branches}`);
      for (const option of Object.values(element.options)) visitIcuElements(option.value, structure);
    }
    if (element.type === TYPE.plural) {
      recordArgument(
        structure,
        element.value,
        `plural:${element.pluralType}:offset=${element.offset}`,
      );
      for (const option of Object.values(element.options)) visitIcuElements(option.value, structure);
    }
    if (element.type === TYPE.tag) {
      structure.tags.add(element.value);
      visitIcuElements(element.children, structure);
    }
  }
}

/** Parse one ICU message into a locale-independent structural signature. */
function getMessageStructure(message) {
  const structure = { arguments: {}, tags: new Set() };
  visitIcuElements(parse(message, { requiresOtherClause: true }), structure);
  return JSON.stringify({
    arguments: Object.fromEntries(Object.entries(structure.arguments).sort()),
    tags: [...structure.tags].sort(),
  });
}

/** Validate identifier shape and ICU syntax for every entry in one loaded catalog. */
function validateCatalogEntries(catalog) {
  const structures = new Map();
  for (const [messageId, message] of Object.entries(catalog.messages)) {
    if (!SEMANTIC_ID_PATTERN.test(messageId)) {
      catalog.diagnostics.push(
        createDiagnostic(
          'catalog.invalidId',
          catalog.filePath,
          'message ID must contain at least two lower-camel semantic path segments',
          messageId,
        ),
      );
    }
    try {
      structures.set(messageId, getMessageStructure(message));
    } catch (error) {
      catalog.diagnostics.push(
        createDiagnostic('catalog.invalidIcu', catalog.filePath, String(error), messageId),
      );
    }
  }
  return structures;
}

/** Compare one production locale against the canonical key and ICU-structure contract. */
function compareLocale(canonical, localeCatalog, canonicalStructures, localeStructures) {
  const canonicalIds = new Set(Object.keys(canonical.messages));
  const localeIds = new Set(Object.keys(localeCatalog.messages));
  for (const messageId of canonicalIds) {
    if (!localeIds.has(messageId)) {
      localeCatalog.diagnostics.push(
        createDiagnostic(
          'catalog.missingKey',
          localeCatalog.filePath,
          `missing key required by ${canonical.locale}`,
          messageId,
        ),
      );
      continue;
    }
    const canonicalStructure = canonicalStructures.get(messageId);
    const localeStructure = localeStructures.get(messageId);
    if (
      canonicalStructure !== undefined &&
      localeStructure !== undefined &&
      canonicalStructure !== localeStructure
    ) {
      localeCatalog.diagnostics.push(
        createDiagnostic(
          'catalog.parameterStructure',
          localeCatalog.filePath,
          `ICU argument or rich-text structure differs from ${canonical.locale}`,
          messageId,
        ),
      );
    }
  }
  for (const messageId of localeIds) {
    if (!canonicalIds.has(messageId)) {
      localeCatalog.diagnostics.push(
        createDiagnostic(
          'catalog.extraKey',
          localeCatalog.filePath,
          `key is not declared by canonical locale ${canonical.locale}`,
          messageId,
        ),
      );
    }
  }
}

/**
 * Validate all supported catalogs as one contract. Callers provide extracted source usage so stale
 * IDs can fail CI; omission intentionally disables only that rule for lower-level consumers.
 */
function checkCatalogs({ catalogPaths, canonicalLocale = 'en-US', usedMessageIds }) {
  const catalogs = Object.entries(catalogPaths).map(([locale, filePath]) => ({
    ...readCatalog(locale, filePath),
    filePath,
  }));
  const canonical = catalogs.find((catalog) => catalog.locale === canonicalLocale);
  if (!canonical) {
    return [
      createDiagnostic(
        'catalog.missingCanonical',
        String(catalogPaths[canonicalLocale] ?? canonicalLocale),
        `canonical catalog ${canonicalLocale} is not configured`,
      ),
    ];
  }

  const structures = new Map(
    catalogs.map((catalog) => [catalog.locale, validateCatalogEntries(catalog)]),
  );
  for (const catalog of catalogs) {
    if (catalog !== canonical) {
      compareLocale(canonical, catalog, structures.get(canonical.locale), structures.get(catalog.locale));
    }
  }

  if (usedMessageIds !== undefined) {
    const used = new Set(usedMessageIds);
    for (const messageId of Object.keys(canonical.messages)) {
      if (!used.has(messageId)) {
        canonical.diagnostics.push(
          createDiagnostic(
            'catalog.staleKey',
            canonical.filePath,
            'canonical message ID is not referenced by extracted source usage',
            messageId,
          ),
        );
      }
    }
  }

  return sortDiagnostics(catalogs.flatMap((catalog) => catalog.diagnostics));
}

module.exports = {
  checkCatalogs,
  getMessageStructure,
  readCatalog,
};

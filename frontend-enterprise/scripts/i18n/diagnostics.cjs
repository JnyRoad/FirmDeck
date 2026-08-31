/** Stable diagnostics shared by internationalization governance CLIs and fixture tests. */

/**
 * Creates one serializable error diagnostic. This function performs no I/O and deliberately keeps
 * values limited to deterministic strings suitable for CI artifacts.
 */
function createDiagnostic(rule, file, message, messageId) {
  return {
    severity: 'error',
    rule,
    file,
    ...(messageId ? { messageId } : {}),
    message,
  };
}

/** Sort diagnostics deterministically so local and CI output compare byte-for-byte. */
function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort((left, right) =>
    [left.file, left.rule, left.messageId ?? '', left.message].join('\0').localeCompare(
      [right.file, right.rule, right.messageId ?? '', right.message].join('\0'),
    ),
  );
}

/** Format structured diagnostics for terminal readers or machine-consumed JSON artifacts. */
function formatDiagnostics(diagnostics, format = 'human') {
  const sorted = sortDiagnostics(diagnostics);
  if (format === 'json') return JSON.stringify(sorted, null, 2);
  if (format !== 'human') throw new Error(`unsupported diagnostics format: ${format}`);
  return sorted
    .map((item) => {
      const id = item.messageId ? ` [${item.messageId}]` : '';
      return `${item.file}: ${item.severity} ${item.rule}${id} ${item.message}`;
    })
    .join('\n');
}

module.exports = {
  createDiagnostic,
  formatDiagnostics,
  sortDiagnostics,
};

import { TYPE, parse, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { describe, expect, it } from 'vitest';

import {
  CANONICAL_LOCALE,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  getLocaleFallbackChain,
  normalizeAppLocale,
} from './locales';
import {
  BACKEND_ERROR_CONTRACT,
  BACKEND_EVENT_CONTRACT,
} from './generated/backendContract';
import englishMessages from './messages/en-US.json';
import chineseMessages from './messages/zh-CN.json';
import pseudoMessages from './generated/en-XA.json';

type Catalog = Record<string, string>;

const MESSAGE_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const catalogs: Record<(typeof SUPPORTED_LOCALES)[number], Catalog> = {
  'en-US': englishMessages,
  'zh-CN': chineseMessages,
};

/**
 * Removes locale prose from one parsed ICU tree while retaining parameter, select, plural, and tag
 * structure. Parsing failures propagate so the test reports the exact catalog and message ID.
 */
function messageStructure(elements: MessageFormatElement[]): unknown[] {
  const structure: unknown[] = [];
  for (const element of elements) {
    if (element.type === TYPE.literal || element.type === TYPE.pound) continue;
    if (element.type === TYPE.argument) {
      structure.push({ type: 'argument', name: element.value });
      continue;
    }
    if (element.type === TYPE.number || element.type === TYPE.date || element.type === TYPE.time) {
      structure.push({ type: element.type, name: element.value, style: element.style ?? null });
      continue;
    }
    if (element.type === TYPE.tag) {
      structure.push({ type: 'tag', name: element.value, children: messageStructure(element.children) });
      continue;
    }

    // Preserve branch names and recursively compare their parameter structures across locales.
    const options = Object.fromEntries(
      Object.entries(element.options).map(([key, option]) => [
        key,
        messageStructure(option.value),
      ]),
    );
    structure.push({
      type: element.type,
      name: element.value,
      pluralType: element.type === TYPE.plural ? element.pluralType : null,
      offset: element.type === TYPE.plural ? element.offset : null,
      options,
    });
  }
  return structure;
}

/** Parses one ICU message and returns a prose-independent structural signature. */
function parseStructure(message: string): unknown[] {
  return messageStructure(parse(message, { captureLocation: false }));
}

/** Collect each ICU parameter and its expression kind for registry-to-catalog contract checks. */
function messageArgumentKinds(
  elements: MessageFormatElement[],
  result = new Map<string, Set<string>>(),
): Map<string, Set<string>> {
  for (const element of elements) {
    const kind = element.type === TYPE.argument
      ? 'argument'
      : element.type === TYPE.number
        ? 'number'
        : element.type === TYPE.date
          ? 'date'
          : element.type === TYPE.time
            ? 'time'
            : element.type === TYPE.select
              ? 'select'
              : element.type === TYPE.plural
                ? 'plural'
                : null;
    if (kind !== null && 'value' in element) {
      const kinds = result.get(element.value) ?? new Set<string>();
      kinds.add(kind);
      result.set(element.value, kinds);
    }
    if (element.type === TYPE.select || element.type === TYPE.plural) {
      for (const option of Object.values(element.options)) messageArgumentKinds(option.value, result);
    }
    if (element.type === TYPE.tag) messageArgumentKinds(element.children, result);
  }
  return result;
}

/** Translate backend primitive kinds into the ICU expression kinds permitted in a catalog. */
function allowedIcuKinds(kind: string): string[] {
  if (kind === 'string') return ['argument', 'select'];
  if (kind === 'boolean') return ['select'];
  if (kind === 'integer') return ['number', 'plural'];
  return ['number'];
}

describe('semantic locale registry', () => {
  it('declares the supported, canonical, default, and fallback locale policy', () => {
    expect(SUPPORTED_LOCALES).toEqual(['zh-CN', 'en-US']);
    expect(DEFAULT_LOCALE).toBe('zh-CN');
    expect(CANONICAL_LOCALE).toBe('en-US');
    expect(getLocaleFallbackChain('zh-CN')).toEqual(['zh-CN', 'en-US']);
    expect(getLocaleFallbackChain('en-US')).toEqual(['en-US']);
  });

  it('normalizes persisted BCP 47 variants and safely defaults unsupported values', () => {
    expect(normalizeAppLocale('EN-us')).toBe('en-US');
    expect(normalizeAppLocale('zh-cn')).toBe('zh-CN');
    expect(normalizeAppLocale('fr-FR')).toBe('zh-CN');
    expect(normalizeAppLocale(null)).toBe('zh-CN');
  });
});

describe('semantic message catalogs', () => {
  it('uses the canonical key set in every production locale', () => {
    const canonicalIds = Object.keys(catalogs[CANONICAL_LOCALE]).sort();

    expect(canonicalIds.length).toBeGreaterThan(0);
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(catalogs[locale]).sort()).toEqual(canonicalIds);
    }
  });

  it('uses stable semantic IDs instead of natural-language or dynamic keys', () => {
    for (const messageId of Object.keys(catalogs[CANONICAL_LOCALE])) {
      expect(messageId).toMatch(MESSAGE_ID_PATTERN);
      expect(messageId).not.toMatch(/[\u3400-\u9fff\s{}]/u);
    }
  });

  it('keeps every message non-empty, ICU-valid, and structurally compatible', () => {
    for (const [messageId, canonicalMessage] of Object.entries(catalogs[CANONICAL_LOCALE])) {
      expect(canonicalMessage.trim()).not.toBe('');
      const canonicalStructure = parseStructure(canonicalMessage);

      for (const locale of SUPPORTED_LOCALES) {
        const localizedMessage = catalogs[locale][messageId];
        expect(localizedMessage.trim()).not.toBe('');
        expect(parseStructure(localizedMessage)).toEqual(canonicalStructure);
      }
    }
  });

  it('keeps generated backend error and event parameter schemas exact', () => {
    const localizedEntries: Array<{
      message_key: string;
      params: Readonly<Record<string, string>>;
      label: string;
    }> = [
      ...Object.values(BACKEND_ERROR_CONTRACT)
        .filter((entry) => entry.visibility === 'public')
        .map((entry) => ({ message_key: entry.message_key, params: entry.params, label: entry.code })),
      ...Object.values(BACKEND_EVENT_CONTRACT)
        .filter((entry) => entry.visibility === 'public' && !entry.raw_source_allowed && entry.message_key)
        .map((entry) => ({ message_key: entry.message_key!, params: entry.params, label: entry.event_code })),
    ];

    for (const entry of localizedEntries) {
      const messageId = entry.message_key;
      expect(messageId).toBeTruthy();
      for (const catalog of Object.values(catalogs)) {
        const message = catalog[messageId];
        expect(message, `${entry.label} catalog entry`).toEqual(expect.any(String));
        const actual = messageArgumentKinds(parse(message, { requiresOtherClause: true }));
        expect([...actual.keys()].sort()).toEqual(Object.keys(entry.params).sort());
        for (const [name, kinds] of actual) {
          expect(allowedIcuKinds(entry.params[name])).toEqual(expect.arrayContaining([...kinds]));
        }
      }
    }
  });

  it('keeps raw or internal events outside the localized catalog contract', () => {
    for (const entry of Object.values(BACKEND_EVENT_CONTRACT)) {
      if (entry.visibility !== 'internal' && !entry.raw_source_allowed) continue;
      expect(entry.message_key).toBeNull();
    }
  });
});

describe('generated pseudo locale', () => {
  it('keeps the canonical key set and valid ICU grammar', () => {
    expect(Object.keys(pseudoMessages).sort()).toEqual(Object.keys(englishMessages).sort());
    for (const message of Object.values(pseudoMessages)) {
      expect(() => parse(message, { requiresOtherClause: true })).not.toThrow();
    }
  });

  it('preserves apostrophe-escaped literal braces while accenting their contents', () => {
    const message = pseudoMessages['modelSetup.custom.extraBodyPlaceholder'];

    expect(message).toContain("'{'");
    expect(message).toContain("'}'");
    expect(message).toContain('ŧħîîñķîîñĝ');
    expect(() => parse(message, { requiresOtherClause: true })).not.toThrow();
  });
});

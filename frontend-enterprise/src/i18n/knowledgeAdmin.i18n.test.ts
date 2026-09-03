/**
 * knowledgeAdmin.* i18n 骨架契约测试。
 *
 * 校验范围（T008，先失败后由 T009 落键使其通过）：
 * 1. `knowledgeAdmin.*` 命名空间的键集合在 en-US（canonical）与 zh-CN 之间完全对等；
 * 2. 每个 `knowledgeAdmin.*` 键的 ICU 具名参数集合在两个目录中一致；
 * 3. `shell.nav.knowledgeAdmin` 键在两个目录中均存在；
 * 4. 四条错误映射键 `errors.knowledge.{baselineStale,rebaseConflictsUnresolved,
 *    versionLevelInvalid,documentLineageMismatch}` 在两个目录中均存在。
 *
 * 本测试只做目录级契约校验，不断言具体文案内容——文案由产品语言（zh-CN）决定，
 * en-US 为 canonical 骨架。
 */
import { TYPE, parse } from '@formatjs/icu-messageformat-parser';
import { describe, expect, it } from 'vitest';

import englishMessages from './messages/en-US.json';
import chineseMessages from './messages/zh-CN.json';

type Catalog = Record<string, string>;

const catalogs: Record<'en-US' | 'zh-CN', Catalog> = {
  'en-US': englishMessages,
  'zh-CN': chineseMessages,
};

const CANONICAL_LOCALE = 'en-US';
const KNOWLEDGE_ADMIN_PREFIX = 'knowledgeAdmin.';

const REQUIRED_ERROR_KEYS = [
  'errors.knowledge.baselineStale',
  'errors.knowledge.rebaseConflictsUnresolved',
  'errors.knowledge.versionLevelInvalid',
  'errors.knowledge.documentLineageMismatch',
] as const;

/** 提取一条 ICU 消息中出现的全部具名参数（argument/number/date/time/select/plural）。 */
function namedArguments(message: string): Set<string> {
  const names = new Set<string>();
  const visit = (elements: ReturnType<typeof parse>): void => {
    for (const element of elements) {
      if (
        element.type === TYPE.argument ||
        element.type === TYPE.number ||
        element.type === TYPE.date ||
        element.type === TYPE.time ||
        element.type === TYPE.select ||
        element.type === TYPE.plural
      ) {
        names.add(element.value);
      }
      if (element.type === TYPE.select || element.type === TYPE.plural) {
        for (const option of Object.values(element.options)) visit(option.value);
      }
      if (element.type === TYPE.tag) visit(element.children);
    }
  };
  visit(parse(message, { requiresOtherClause: true }));
  return names;
}

function knowledgeAdminKeys(catalog: Catalog): string[] {
  return Object.keys(catalog).filter((key) => key.startsWith(KNOWLEDGE_ADMIN_PREFIX));
}

describe('knowledgeAdmin.* i18n skeleton contract', () => {
  it('declares at least one knowledgeAdmin.* key in the canonical catalog', () => {
    expect(knowledgeAdminKeys(catalogs[CANONICAL_LOCALE]).length).toBeGreaterThan(0);
  });

  it('keeps the knowledgeAdmin.* key set identical between en-US and zh-CN', () => {
    const canonicalKeys = knowledgeAdminKeys(catalogs[CANONICAL_LOCALE]).sort();
    const localeKeys = knowledgeAdminKeys(catalogs['zh-CN']).sort();
    expect(localeKeys).toEqual(canonicalKeys);
  });

  it('keeps the ICU named-argument set identical per knowledgeAdmin.* key across locales', () => {
    for (const key of knowledgeAdminKeys(catalogs[CANONICAL_LOCALE])) {
      const canonicalArgs = [...namedArguments(catalogs[CANONICAL_LOCALE][key])].sort();
      const localeArgs = [...namedArguments(catalogs['zh-CN'][key])].sort();
      expect(localeArgs, `zh-CN ICU params for "${key}"`).toEqual(canonicalArgs);
    }
  });

  it('declares shell.nav.knowledgeAdmin in every production locale', () => {
    for (const locale of Object.keys(catalogs) as Array<keyof typeof catalogs>) {
      expect(catalogs[locale]['shell.nav.knowledgeAdmin'], `${locale} shell.nav.knowledgeAdmin`)
        .toEqual(expect.any(String));
    }
  });

  it('declares the four errors.knowledge.* mapping keys in every production locale', () => {
    for (const locale of Object.keys(catalogs) as Array<keyof typeof catalogs>) {
      for (const errorKey of REQUIRED_ERROR_KEYS) {
        expect(catalogs[locale][errorKey], `${locale} ${errorKey}`).toEqual(expect.any(String));
      }
    }
  });
});

/**
 * 验证统一 locale formatter 的日期、数字、复数、列表和排序契约。
 * 这些测试先于 formatters.ts 实现，用来锁定显式时区与当前 locale 的行为。
 */

import { describe, expect, it } from 'vitest';

import { createFormatters } from './formatters';

type SupportedLocale = 'zh-CN' | 'en-US';

/** 根据 locale 创建待测 formatter，所有断言都通过公开的 facade 验证行为。 */
function createTestFormatters(locale: SupportedLocale) {
  return createFormatters(locale);
}

/** 生成与待测日期格式相同的标准 Intl 结果，避免把平台字符串拼接写进生产契约。 */
function expectedDate(
  locale: SupportedLocale,
  value: Date,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}

/** 生成与待测时间格式相同的标准 Intl 结果，并保留调用方指定的时区。 */
function expectedTime(
  locale: SupportedLocale,
  value: Date,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}

/** 断言日期和时间均按当前 locale 和调用方显式 timezone 输出，而不是读取固定地区。 */
function verifiesDateAndTimeLocaleAndTimezone(): void {
  const value = new Date('2026-08-11T23:30:00Z');
  const dateOptions: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'long',
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
  };
  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  };
  const zh = createTestFormatters('zh-CN');
  const en = createTestFormatters('en-US');

  expect(zh.formatDate(value, dateOptions)).toBe(expectedDate('zh-CN', value, dateOptions));
  expect(en.formatDate(value, dateOptions)).toBe(expectedDate('en-US', value, dateOptions));
  expect(zh.formatTime(value, timeOptions)).toBe(expectedTime('zh-CN', value, timeOptions));
  expect(en.formatTime(value, timeOptions)).toBe(expectedTime('en-US', value, timeOptions));
  expect(zh.formatDate(value, dateOptions)).not.toBe(en.formatDate(value, dateOptions));
}

/** 断言数字、货币和百分比共享 locale-aware Intl 规则而不散落手工拼接。 */
function verifiesNumberCurrencyAndPercentFormatting(): void {
  const value = 1234567.89;
  const numberOptions: Intl.NumberFormatOptions = { maximumFractionDigits: 2 };
  const currencyOptions: Intl.NumberFormatOptions = {
    currency: 'USD',
    maximumFractionDigits: 2,
    style: 'currency',
  };
  const percentOptions: Intl.NumberFormatOptions = {
    maximumFractionDigits: 1,
    style: 'percent',
  };
  const zh = createTestFormatters('zh-CN');
  const en = createTestFormatters('en-US');

  expect(zh.formatNumber(value, numberOptions)).toBe(
    new Intl.NumberFormat('zh-CN', numberOptions).format(value),
  );
  expect(en.formatNumber(value, numberOptions)).toBe(
    new Intl.NumberFormat('en-US', numberOptions).format(value),
  );
  expect(en.formatNumber(value, currencyOptions)).toBe(
    new Intl.NumberFormat('en-US', currencyOptions).format(value),
  );
  expect(zh.formatNumber(0.125, percentOptions)).toBe(
    new Intl.NumberFormat('zh-CN', percentOptions).format(0.125),
  );
}

/** 断言复数类别来自 locale 的 CLDR 规则，而不是把所有语言压缩成单复数二分法。 */
function verifiesLocalePluralRules(): void {
  const zh = createTestFormatters('zh-CN');
  const en = createTestFormatters('en-US');
  const zhRules = new Intl.PluralRules('zh-CN');
  const enRules = new Intl.PluralRules('en-US');

  expect(zh.formatPlural(0)).toBe(zhRules.select(0));
  expect(zh.formatPlural(1)).toBe(zhRules.select(1));
  expect(en.formatPlural(1)).toBe(enRules.select(1));
  expect(en.formatPlural(2)).toBe(enRules.select(2));
}

/** 断言列表连接词和顺序由 locale 的 ListFormat 规则决定。 */
function verifiesLocaleListFormatting(): void {
  const values = ['Alice', 'Bob', 'Carol'];
  const options: Intl.ListFormatOptions = { style: 'long', type: 'conjunction' };
  const zh = createTestFormatters('zh-CN');
  const en = createTestFormatters('en-US');

  expect(zh.formatList(values, options)).toBe(new Intl.ListFormat('zh-CN', options).format(values));
  expect(en.formatList(values, options)).toBe(new Intl.ListFormat('en-US', options).format(values));
  expect(zh.formatList(values, options)).not.toBe(en.formatList(values, options));
}

/** 断言相对时间和排序使用当前 locale，并且排序不会固定为中文地区。 */
function verifiesRelativeTimeAndCollation(): void {
  const values = ['z', 'ä', 'a'];
  const zh = createTestFormatters('zh-CN');
  const en = createTestFormatters('en-US');
  const collatorOptions: Intl.CollatorOptions = { usage: 'sort' };
  const expectedZhOrder = [...values].sort(new Intl.Collator('zh-CN', collatorOptions).compare);
  const expectedEnOrder = [...values].sort(new Intl.Collator('en-US', collatorOptions).compare);

  expect(zh.formatRelativeTime(-1, 'day')).toBe(new Intl.RelativeTimeFormat('zh-CN').format(-1, 'day'));
  expect(en.formatRelativeTime(2, 'hour')).toBe(new Intl.RelativeTimeFormat('en-US').format(2, 'hour'));
  expect([...values].sort(zh.collator(collatorOptions).compare)).toEqual(expectedZhOrder);
  expect([...values].sort(en.collator(collatorOptions).compare)).toEqual(expectedEnOrder);
}

describe('locale-aware formatters', () => {
  it('formats dates and times using the active locale and explicit timezone', verifiesDateAndTimeLocaleAndTimezone);
  it('formats numbers, currencies, and percentages with Intl options', verifiesNumberCurrencyAndPercentFormatting);
  it('uses locale-specific CLDR plural categories', verifiesLocalePluralRules);
  it('formats lists with locale-specific conjunction rules', verifiesLocaleListFormatting);
  it('formats relative time and sorts with the active locale collator', verifiesRelativeTimeAndCollation);
});

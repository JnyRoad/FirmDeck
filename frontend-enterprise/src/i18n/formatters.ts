/**
 * 提供不依赖 React 生命周期的 locale-aware 格式化 facade，统一日期、数字、复数、列表和排序。
 * 所有输出都由调用方传入的 locale 与 Intl 选项决定，不读取全局语言状态或修改业务数据。
 */

import { parseBackendDateTime } from '@/lib/timezone';

import type { AppLocale } from './locales';

export type FormatterDateValue = Date | number | string;

export type LocaleFormatters = {
  formatDate: (value: FormatterDateValue, options?: Intl.DateTimeFormatOptions) => string;
  formatTime: (value: FormatterDateValue, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatPlural: (value: number, options?: Intl.PluralRulesOptions) => Intl.LDMLPluralRule;
  formatRelativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit) => string;
  formatList: (values: string[], options?: Intl.ListFormatOptions) => string;
  collator: (options?: Intl.CollatorOptions) => Intl.Collator;
};

/** 将 Date、epoch milliseconds 或后端 ISO 字符串转换为可格式化的 Date。 */
function toDate(value: FormatterDateValue): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  return parseBackendDateTime(value);
}

/** 创建绑定到指定 locale 的格式化 facade；每个方法只使用显式输入和标准 Intl 规则。 */
export function createFormatters(locale: AppLocale): LocaleFormatters {
  /** 按指定 locale 和 timezone/options 输出日期，不拼接自然语言片段。 */
  function formatDate(value: FormatterDateValue, options: Intl.DateTimeFormatOptions = {}): string {
    return new Intl.DateTimeFormat(locale, options).format(toDate(value));
  }

  /** 按指定 locale 和 timezone/options 输出时间，不假定服务器或浏览器默认时区。 */
  function formatTime(value: FormatterDateValue, options: Intl.DateTimeFormatOptions = {}): string {
    return new Intl.DateTimeFormat(locale, options).format(toDate(value));
  }

  /** 使用 Intl.NumberFormat 统一处理普通数字、货币、百分比和其他数字样式。 */
  function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
    return new Intl.NumberFormat(locale, options).format(value);
  }

  /** 使用当前 locale 的 CLDR 复数规则返回消息选择所需的类别。 */
  function formatPlural(value: number, options: Intl.PluralRulesOptions = {}): Intl.LDMLPluralRule {
    return new Intl.PluralRules(locale, options).select(value);
  }

  /** 使用当前 locale 的 RelativeTimeFormat 输出相对时间，不拼接固定语言单位。 */
  function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string {
    return new Intl.RelativeTimeFormat(locale).format(value, unit);
  }

  /** 使用当前 locale 的 ListFormat 连接列表，保留业务值本身不被翻译。 */
  function formatList(values: string[], options: Intl.ListFormatOptions = {}): string {
    return new Intl.ListFormat(locale, options).format(values);
  }

  /** 创建绑定当前 locale 的 Collator，供排序逻辑显式使用而非固定中文地区。 */
  function collator(options: Intl.CollatorOptions = {}): Intl.Collator {
    return new Intl.Collator(locale, options);
  }

  return {
    formatDate,
    formatTime,
    formatNumber,
    formatPlural,
    formatRelativeTime,
    formatList,
    collator,
  };
}

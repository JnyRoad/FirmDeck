import { DEFAULT_LOCALE, type AppLocale } from '@/i18n/locales';

const FALLBACK_TIME_ZONE = 'Asia/Shanghai';

/** 获取浏览器报告的 IANA 时区；浏览器无法提供时使用兼容性默认值。 */
export function getClientTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/** 将后端 wire timestamp 解析为绝对时刻；无 offset 的 ISO 时间按 UTC 处理。 */
export function parseBackendDateTime(value?: string): Date {
  const text = String(value || '').trim();
  if (!text) return new Date('');
  // 纯日期字符串本就被当作 UTC 解析，无需补时区后缀
  if (!text.includes('T')) return new Date(text);
  // 后端时间戳为 naive UTC（无 Z 后缀），缺失时按 UTC 解析而非本地时间
  if (/([zZ]|[+-]\d{2}:\d{2})$/.test(text)) return new Date(text);
  return new Date(`${text}Z`);
}

/** 按显式 UI locale 和客户端 timezone 展示后端时间；缺省 locale 仅保留旧调用的确定性兼容值。 */
export function formatClientDateTime(
  value?: string,
  locale: AppLocale = DEFAULT_LOCALE,
  emptyText = '-',
): string {
  if (!value) return emptyText;
  const date = parseBackendDateTime(value);
  if (Number.isNaN(date.getTime())) return emptyText;
  return date.toLocaleString(locale, {
    hour12: false,
    timeZone: getClientTimeZone(),
  });
}

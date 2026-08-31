/**
 * 维护前端可持久化语言区域的唯一注册表，并在浏览器存储边界执行 BCP 47 归一化。
 */

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'zh-CN';
export const CANONICAL_LOCALE: AppLocale = 'en-US';
export const LOCALE_STORAGE_KEY = 'staffdeck_locale';

/**
 * 将外部语言标签整理为标准 BCP 47 形式；无效输入返回 null，且不修改任何全局状态。
 */
function canonicalizeLocaleTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().replace(/_/g, '-');
  if (!candidate) return null;

  try {
    return Intl.getCanonicalLocales(candidate)[0] || null;
  } catch {
    return null;
  }
}

/**
 * 将受支持语言区域的大小写或分隔符变体解析为注册值；不支持或非法的标签返回 null。
 */
export function canonicalizeAppLocale(value: unknown): AppLocale | null {
  const canonical = canonicalizeLocaleTag(value);
  if (!canonical) return null;
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === canonical) return locale;
  }
  return null;
}

/**
 * 将持久化或兼容入口的语言标签归一化；无法识别时确定性回退到中文兼容默认值。
 */
export function normalizeAppLocale(value: unknown): AppLocale {
  return canonicalizeAppLocale(value) ?? DEFAULT_LOCALE;
}

/**
 * 返回一个语言区域的确定性消息回退顺序；中文缺失时回退到英文规范目录，英文不再继续回退。
 */
export function getLocaleFallbackChain(value: unknown): readonly AppLocale[] {
  const locale = normalizeAppLocale(value);
  return locale === CANONICAL_LOCALE
    ? [CANONICAL_LOCALE]
    : [locale, CANONICAL_LOCALE];
}

/** 集中暴露语义 i18n 公共入口，并让 AppIntlProvider 成为应用唯一的 locale owner。 */

import { createElement } from 'react';

import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, normalizeAppLocale, type AppLocale } from './locales';
import { AppIntlProvider, type AppIntlProviderProps } from './provider';

/**
 * 提供应用根 i18n 边界；这是 AppIntlProvider 的兼容命名入口，不再创建第二份 locale 状态。
 */
export function I18nProvider(props: AppIntlProviderProps) {
  return createElement(AppIntlProvider, props);
}

/** 读取持久化 locale 偏好，供 Provider 外的纯 translator 工厂使用，不维护全局 locale 状态。 */
export function getStoredLocale(): AppLocale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    return normalizeAppLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE;
  }
}

export { AppIntlProvider } from './provider';
export { createAppIntl, createAppTranslator } from './imperative';
export { useAppIntl } from './useAppIntl';
export type { AppIntlProviderProps } from './provider';
export type { AppTranslator, MessageValue, MessageValues } from './imperative';
export type { AppLocale, MessageId } from './types';
export type { AppI18n } from './useAppIntl';

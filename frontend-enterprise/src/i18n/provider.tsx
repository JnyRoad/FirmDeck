/**
 * 将持久化语言偏好、React Intl 和 StaffDeck facade 组合为语义消息运行时的 React 根边界。
 */

import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { RawIntlProvider } from 'react-intl';

import {
  canonicalizeAppLocale,
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  normalizeAppLocale,
  type AppLocale,
} from './locales';
import { createAppTranslator } from './imperative';
import type { AppI18n } from './useAppIntl';

export type AppIntlProviderProps = {
  children: ReactNode;
  initialLocale?: AppLocale | string | null;
  locale?: AppLocale;
  onLocaleChange?: (locale: AppLocale) => void;
};

export const AppIntlContext = createContext<AppI18n | null>(null);

/**
 * 在非生产环境记录偏好存储问题；诊断不包含应用数据，也不会阻止默认语言继续渲染。
 */
function reportLocaleDiagnostic(message: string): void {
  if (import.meta.env.PROD !== true) console.warn(`[i18n] ${message}`);
}

/**
 * 解析 Provider 初始语言；显式值优先，其次读取既有 storage key，读取失败时回退兼容默认值。
 */
function resolveInitialLocale(initialLocale?: AppLocale | string | null): AppLocale {
  if (initialLocale != null) return normalizeAppLocale(initialLocale);
  if (typeof window === 'undefined') return DEFAULT_LOCALE;

  try {
    const storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (storedLocale && !canonicalizeAppLocale(storedLocale)) {
      reportLocaleDiagnostic(`Unsupported stored locale normalized to ${DEFAULT_LOCALE}`);
    }
    return normalizeAppLocale(storedLocale);
  } catch (error) {
    reportLocaleDiagnostic(error instanceof Error ? error.name : 'Unable to read stored locale');
    return DEFAULT_LOCALE;
  }
}

/**
 * 将已归一化语言写回既有 storage key；浏览器拒绝存储时记录诊断但保持内存状态可用。
 */
function persistLocale(locale: AppLocale): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch (error) {
    reportLocaleDiagnostic(error instanceof Error ? error.name : 'Unable to persist locale');
  }
}

/**
 * 为子树提供类型化消息和 React Intl 实例；切换语言会持久化偏好并同步 document.lang。
 */
export function AppIntlProvider({
  children,
  initialLocale,
  locale: controlledLocale,
  onLocaleChange,
}: AppIntlProviderProps) {
  /** 首次渲染只解析一次显式值或持久化偏好，避免渲染期间重复读取浏览器存储。 */
  const [uncontrolledLocale, setUncontrolledLocale] = useState<AppLocale>(
    () => resolveInitialLocale(initialLocale),
  );
  const locale = controlledLocale ?? uncontrolledLocale;

  /** 接收 facade 的语言切换，并同步受控父级或本地状态以及兼容 storage key。 */
  const setLocale = useCallback((nextLocale: AppLocale) => {
    const normalized = normalizeAppLocale(nextLocale);
    persistLocale(normalized);
    if (controlledLocale == null) setUncontrolledLocale(normalized);
    onLocaleChange?.(normalized);
  }, [controlledLocale, onLocaleChange]);

  /** 在 locale 状态稳定后更新文档语言，SSR 或纯测试环境没有 document 时不产生副作用。 */
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);

  /** locale 变化时创建或取得对应的不可变组件外翻译器和 React Intl 实例。 */
  const translator = useMemo(() => createAppTranslator(locale), [locale]);

  /** 只在 locale 或翻译实例变化时更新 facade，避免无关父组件渲染扩散到消费者。 */
  const contextValue = useMemo<AppI18n>(() => ({
    locale,
    setLocale,
    t: translator.t,
  }), [locale, setLocale, translator]);

  return (
    <RawIntlProvider value={translator.intl}>
      <AppIntlContext.Provider value={contextValue}>
        {children}
      </AppIntlContext.Provider>
    </RawIntlProvider>
  );
}

export default AppIntlProvider;

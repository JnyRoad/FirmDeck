/**
 * 定义 StaffDeck 组件层使用的稳定 i18n facade，避免业务组件直接绑定第三方 Provider 细节。
 */

import { useContext } from 'react';

import type { AppLocale } from './locales';
import { AppIntlContext } from './provider';
import type { MessageValues } from './imperative';
import type { MessageId } from './types';

export type AppI18n = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: (id: MessageId, values?: MessageValues) => string;
};

/**
 * 返回当前 React 子树的 StaffDeck i18n facade；Provider 缺失时立即抛错以暴露集成缺陷。
 */
export function useAppIntl(): AppI18n {
  const context = useContext(AppIntlContext);
  if (!context) throw new Error('useAppIntl must be used inside AppIntlProvider');
  return context;
}

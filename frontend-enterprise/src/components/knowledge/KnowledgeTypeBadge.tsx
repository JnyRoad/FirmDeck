import { useContext, useMemo } from 'react';

import { createAppTranslator, getStoredLocale } from '@/i18n';
import { AppIntlContext } from '@/i18n/provider';
import type { KnowledgeBaseRead } from '@/types';

type KnowledgeTypeBadgeProps = {
  mode?: KnowledgeBaseRead['mode'];
};

/** 为知识库类型标签提供稳定翻译入口；无 Provider 时回退当前持久化 locale。 */
function useKnowledgeTypeBadgeIntl() {
  const context = useContext(AppIntlContext);
  return useMemo(() => context ?? createAppTranslator(getStoredLocale()), [context]);
}

export function KnowledgeTypeBadge({ mode = 'dedicated' }: KnowledgeTypeBadgeProps) {
  /** 用产品确认的名称区分员工专用库与团队可绑定共享库。 */
  const { t } = useKnowledgeTypeBadgeIntl();
  const shared = mode === 'shared';
  const label = shared ? t('knowledgePage.type.shared') : t('knowledgePage.type.dedicated');
  return (
    <span
      aria-label={t('knowledgePage.type.aria', { label })}
      className={shared
        ? 'inline-flex items-center rounded-full bg-[#ede9fe] px-[9px] py-[3px] text-[11px] font-medium text-[#6d28d9]'
        : 'inline-flex items-center rounded-full bg-[#eef2f7] px-[9px] py-[3px] text-[11px] font-medium text-[#596174]'}
    >
      {label}
    </span>
  );
}

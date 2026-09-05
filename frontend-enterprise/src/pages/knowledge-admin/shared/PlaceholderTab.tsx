/**
 * 知识库管理 · 详情页占位 Tab：内容 / 版本管理 / 分支 / 群组与权限 / 审计日志在本批次
 * （US1）尚未实现，先渲染统一的"待实现"提示，避免遗漏 Tab 壳。
 */

import { useAppIntl } from '@/i18n';

export function PlaceholderTab() {
  const { t } = useAppIntl();
  return (
    <div className="flex h-[160px] items-center justify-center rounded-[14px] border-[0.5px] border-dashed border-[#e3e7f1] bg-white text-[13px] text-[#858b9c]">
      {t('knowledgeAdmin.detail.placeholder.pending')}
    </div>
  );
}

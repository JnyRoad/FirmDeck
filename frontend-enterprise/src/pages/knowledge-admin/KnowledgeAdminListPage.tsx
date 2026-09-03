/**
 * 知识库管理 · 列表页骨架：仅承载路由与 admin-only 页面外壳，具体列表、筛选与操作由 US1 任务替换。
 * 页面不读取 readEmployeeScope，也不监听 agent-scope 事件。
 */

import { useAppIntl } from '@/i18n';

export default function KnowledgeAdminListPage() {
  const { t } = useAppIntl();

  return (
    <div className="px-[24px] py-[24px]">
      <h1 className="text-[20px] font-semibold">{t('knowledgeAdmin.list.title')}</h1>
    </div>
  );
}

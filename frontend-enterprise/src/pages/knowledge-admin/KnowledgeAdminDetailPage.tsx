/**
 * 知识库管理 · 详情页骨架：仅承载路由参数与 admin-only 页面外壳，内容/版本/群组/审计/设置分区由 US1 任务替换。
 * 页面不读取 readEmployeeScope，也不监听 agent-scope 事件。
 */

import { useParams } from 'react-router-dom';

import { useAppIntl } from '@/i18n';
import { RawIdentifier } from '@/i18n/RawContent';

export default function KnowledgeAdminDetailPage() {
  const { kbId = '' } = useParams<{ kbId: string }>();
  const { t } = useAppIntl();

  return (
    <div className="px-[24px] py-[24px]">
      <h1 className="text-[20px] font-semibold">{t('knowledgeAdmin.list.title')}</h1>
      <p className="mt-[8px] text-[14px] text-[#646b7c]">
        <RawIdentifier value={kbId} />
      </p>
    </div>
  );
}

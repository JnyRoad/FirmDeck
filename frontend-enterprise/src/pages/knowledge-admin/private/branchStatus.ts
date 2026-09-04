/**
 * 私有库分支 Tab 集（`private/ContentTab.tsx`、`private/BranchTab.tsx`）共用的纯函数：
 * 把 `KnowledgeBaseRead.branch_sync_state` 映射为文案键。直接复用列表页
 * `knowledgeAdminModel.ts` 里已经登记的 `knowledgeAdmin.list.version.syncState.*`
 * 四个键（同一语义："分支头与广场基线的同步状态"），不新增重复文案。
 */
import type { MessageId } from '@/i18n/types';

const BRANCH_SYNC_MESSAGE_IDS: Record<string, MessageId> = {
  synced: 'knowledgeAdmin.list.version.syncState.synced',
  diverged: 'knowledgeAdmin.list.version.syncState.diverged',
  converted: 'knowledgeAdmin.list.version.syncState.converted',
};

const UNKNOWN_BRANCH_SYNC_MESSAGE_ID: MessageId = 'knowledgeAdmin.list.version.syncState.unknown';

/** 未识别 / 缺失的同步状态一律落到「未知」文案键，不静默丢弃。 */
export function branchSyncMessageId(syncState: string | null | undefined): MessageId {
  if (!syncState) return UNKNOWN_BRANCH_SYNC_MESSAGE_ID;
  return BRANCH_SYNC_MESSAGE_IDS[syncState] ?? UNKNOWN_BRANCH_SYNC_MESSAGE_ID;
}

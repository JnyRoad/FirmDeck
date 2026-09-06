import { useEffect, useState } from 'react';

import { Badge, Button } from '@/components/ui';
import { useAppIntl, type MessageId, type MessageValues } from '@/i18n';
import { RawIdentifier } from '@/i18n/RawContent';
import type {
  KnowledgePermission,
  TeamKnowledgeBindingRead,
  TeamKnowledgeGrantInput,
  TeamMemberRead,
} from '@/types';

type PermissionChoice = KnowledgePermission | 'none';

type PermissionMatrixMessageId = MessageId;

type TeamKnowledgePermissionMatrixProps = {
  binding: TeamKnowledgeBindingRead;
  members: TeamMemberRead[];
  busy?: boolean;
  /**
   * 是否展示批量设置按钮组（全部只读 / 全部可编辑 / 全部撤销）。默认关闭，
   * 保持 `TeamDetailPage` 既有渲染结果不变；`GrantsTab` 显式开启。
   */
  showBulkActions?: boolean;
  onSave: (
    binding: TeamKnowledgeBindingRead,
    grants: TeamKnowledgeGrantInput[],
  ) => Promise<void>;
  onSetDefault: (binding: TeamKnowledgeBindingRead) => Promise<void>;
  onRemove: (binding: TeamKnowledgeBindingRead) => Promise<void>;
};

/** Render and edit one team-by-knowledge-base permission matrix. */
export default function TeamKnowledgePermissionMatrix({
  binding,
  members,
  busy = false,
  showBulkActions = false,
  onSave,
  onSetDefault,
  onRemove,
}: TeamKnowledgePermissionMatrixProps) {
  const [permissions, setPermissions] = useState<Record<string, PermissionChoice>>({});
  const { t: appT } = useAppIntl();
  /** 将待补齐目录键适配到受控 MessageId；成员与知识库名称仍作为 raw 参数。 */
  const t = (id: PermissionMatrixMessageId, values?: MessageValues) => appT(id, values);

  useEffect(() => {
    /** Rebuild visible permissions whenever the server revision or roster changes. */
    const activeByAgent = new Map(
      binding.grants
        .filter((grant) => grant.status === 'active')
        .map((grant) => [grant.agent_id, grant.permission] as const),
    );
    setPermissions(Object.fromEntries(
      members.map((member) => [member.agent_id, activeByAgent.get(member.agent_id) || 'none']),
    ));
  }, [binding.grants, binding.revision, members]);

  /** 把矩阵里全部成员的本地权限选择一次性改成同一个值；不发起保存请求，需另行点击「保存权限」。 */
  function applyBulkPermission(choice: PermissionChoice) {
    setPermissions(Object.fromEntries(members.map((member) => [member.agent_id, choice])));
  }

  /** Convert the complete visible matrix into the atomic API payload. */
  function grantPayload(): TeamKnowledgeGrantInput[] {
    return members.map((member) => ({
      agent_id: member.agent_id,
      permission: permissions[member.agent_id] === 'none'
        ? null
        : permissions[member.agent_id] as KnowledgePermission,
    }));
  }

  return (
    <article className="rounded-[14px] border border-[#e7eaf1] bg-[#fafbfd] p-[14px]">
      <div className="flex flex-wrap items-start justify-between gap-[10px]">
        <div>
          <div className="flex flex-wrap items-center gap-[8px]">
            <h3 className="text-[14px] font-medium text-[#18181a]"><RawIdentifier value={binding.knowledge_base_name} /></h3>
            <Badge className="rounded-full bg-[#e8f0ff] text-[11px] font-normal text-[#1a71ff]">
              {t('teamKnowledgePermissionMatrix.badge.shared')}
            </Badge>
            {binding.is_default && (
              <Badge className="rounded-full bg-[#eaf7ef] text-[11px] font-normal text-[#287a4d]">
                {t('teamKnowledgePermissionMatrix.badge.default')}
              </Badge>
            )}
          </div>
          <p className="mt-[4px] text-[12px] text-[#858b9c]">
            {t('teamKnowledgePermissionMatrix.versionInfo', {
              version: binding.published_version || '--',
              revision: binding.revision,
            })}
          </p>
        </div>
        <div className="flex flex-wrap gap-[6px]">
          {!binding.is_default && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              aria-label={t('teamKnowledgePermissionMatrix.action.setDefault', {
                knowledgeBaseName: binding.knowledge_base_name,
              })}
              onClick={() => void onSetDefault(binding)}
              className="h-[30px] rounded-[9px] px-[10px] text-[12px]"
            >
              {t('teamKnowledgePermissionMatrix.action.setDefaultButton')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            aria-label={t('teamKnowledgePermissionMatrix.action.remove', {
              knowledgeBaseName: binding.knowledge_base_name,
            })}
            onClick={() => void onRemove(binding)}
            className="h-[30px] rounded-[9px] px-[10px] text-[12px] text-[#c0342b]"
          >
            {t('teamKnowledgePermissionMatrix.action.removeButton')}
          </Button>
        </div>
      </div>

      {showBulkActions && members.length > 0 && (
        <div className="mt-[12px] flex flex-wrap gap-[6px]">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => applyBulkPermission('reader')}
            className="h-[28px] rounded-[8px] px-[10px] text-[12px]"
          >
            {t('teamKnowledgePermissionMatrix.bulk.reader')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => applyBulkPermission('editor')}
            className="h-[28px] rounded-[8px] px-[10px] text-[12px]"
          >
            {t('teamKnowledgePermissionMatrix.bulk.editor')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => applyBulkPermission('none')}
            className="h-[28px] rounded-[8px] px-[10px] text-[12px]"
          >
            {t('teamKnowledgePermissionMatrix.bulk.none')}
          </Button>
        </div>
      )}

      {members.length === 0 ? (
        <p className="mt-[12px] text-[12px] text-[#a7adbb]">
          {t('teamKnowledgePermissionMatrix.emptyMembers')}
        </p>
      ) : (
      <div className="mt-[12px] grid gap-[8px] sm:grid-cols-2 lg:grid-cols-3">
        {members.map((member) => (
          <label
            key={member.agent_id}
            className="flex items-center justify-between gap-[8px] rounded-[10px] bg-white px-[10px] py-[8px] text-[12px] text-[#464c5e]"
          >
            <span className="min-w-0 truncate"><RawIdentifier value={member.agent_name || member.agent_id} /></span>
            <select
              aria-label={t('teamKnowledgePermissionMatrix.permissionLabel', {
                memberName: member.agent_name || member.agent_id,
                knowledgeBaseName: binding.knowledge_base_name,
              })}
              value={permissions[member.agent_id] || 'none'}
              disabled={busy}
              onChange={(event) => setPermissions((current) => ({
                ...current,
                [member.agent_id]: event.target.value as PermissionChoice,
              }))}
              className="h-[30px] rounded-[8px] border border-[#dfe4ed] bg-white px-[8px] text-[12px] text-[#18181a]"
            >
              <option value="none">{t('teamKnowledgePermissionMatrix.permission.none')}</option>
              <option value="reader">{t('teamKnowledgePermissionMatrix.permission.reader')}</option>
              <option value="editor">{t('teamKnowledgePermissionMatrix.permission.editor')}</option>
              <option value="publisher">{t('teamKnowledgePermissionMatrix.permission.publisher')}</option>
            </select>
          </label>
        ))}
      </div>
      )}

      <div className="mt-[10px] flex justify-end">
        <Button
          type="button"
          disabled={busy}
          aria-label={t('teamKnowledgePermissionMatrix.action.save', {
            knowledgeBaseName: binding.knowledge_base_name,
          })}
          onClick={() => void onSave(binding, grantPayload())}
          className="h-[30px] rounded-[9px] bg-primary px-[12px] text-[12px] text-white"
        >
          {busy
            ? t('teamKnowledgePermissionMatrix.action.saving')
            : t('teamKnowledgePermissionMatrix.action.saveButton')}
        </Button>
      </div>
    </article>
  );
}

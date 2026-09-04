/**
 * 知识库管理 · 详情页「设置」Tab：基本信息（名称/描述/能力范围）保存、上线/下线切换、
 * 危险区删除。三类操作分别对应既有 `PUT`/`DELETE /knowledge-bases/{kb_id}` 端点。
 */

import { useEffect, useState } from 'react';

import { CapabilityScopeControl, normalizeCapabilityScope } from '@/components/CapabilityScopeControl';
import { Input, Textarea } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useAppIntl } from '@/i18n';
import { createMessageDescriptor } from '@/i18n/descriptors';
import type { KnowledgeAdminApi } from '@/api/knowledgeAdmin';
import type { CapabilityScope, KnowledgeBaseRead } from '@/types';

import { DeleteDialog } from '../dialogs/DeleteDialog';
import { useKnowledgeAdminToast } from './errorMessage';

export type SettingsTabProps = {
  api: KnowledgeAdminApi;
  kb: KnowledgeBaseRead;
  /** 进行中草稿数，透传给删除确认对话框；私有库分支恒为 0。 */
  draftCount: number;
  /** 草稿数未能成功获取（`listVersions` 单独失败）；透传给删除确认对话框，展示"无法确认"。 */
  draftCountUnknown?: boolean;
  /** 名称/描述/能力范围保存或上线状态切换成功后回调，携带后端返回的最新知识库。 */
  onUpdated: (kb: KnowledgeBaseRead) => void;
  /** 删除成功后回调，由详情页负责跳回列表。 */
  onDeleted: () => void;
};

const CARD_CLASS = 'rounded-[14px] border-[0.5px] border-[#e3e7f1] bg-white p-[20px]';

/** 基本信息 / 上线状态 / 危险区三张卡片；每张卡片内部各自管理保存态，互不阻塞。 */
export function SettingsTab({ api, kb, draftCount, draftCountUnknown = false, onUpdated, onDeleted }: SettingsTabProps) {
  const { t } = useAppIntl();
  const toast = useKnowledgeAdminToast();
  const [name, setName] = useState(kb.name);
  const [description, setDescription] = useState(kb.description || '');
  const [capabilityScope, setCapabilityScope] = useState<CapabilityScope>(normalizeCapabilityScope(kb.capability_scope));
  const [nameError, setNameError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setName(kb.name);
    setDescription(kb.description || '');
    setCapabilityScope(normalizeCapabilityScope(kb.capability_scope));
    setNameError(false);
  }, [kb.id, kb.name, kb.description, kb.capability_scope]);

  async function saveBasicInfo() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(true);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateKnowledgeBase(kb.id, {
        name: trimmedName,
        description: description.trim(),
        capabilityScope,
      });
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.updateSuccess'));
      onUpdated(updated);
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus() {
    const nextStatus = kb.status === 'active' ? 'archived' : 'active';
    setStatusSaving(true);
    try {
      const updated = await api.updateKnowledgeBase(kb.id, { status: nextStatus });
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.updateSuccess'));
      onUpdated(updated);
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
    } finally {
      setStatusSaving(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.deleteKnowledgeBase(kb.id);
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.deleteSuccess'));
      setDeleteOpen(false);
      onDeleted();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.deleteError');
    } finally {
      setDeleting(false);
    }
  }

  const isActive = kb.status === 'active';

  return (
    <div className="flex flex-col gap-[16px]">
      <section className={CARD_CLASS} aria-label={t('knowledgeAdmin.detail.settings.basicInfo.title')}>
        <h2 className="text-[14px] font-semibold text-[#18181a]">{t('knowledgeAdmin.detail.settings.basicInfo.title')}</h2>
        <div className="mt-[16px] flex flex-col gap-[14px]">
          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.detail.settings.basicInfo.nameLabel')}</span>
            <Input
              value={name}
              disabled={saving}
              aria-invalid={nameError}
              aria-label={t('knowledgeAdmin.detail.settings.basicInfo.nameLabel')}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(false);
              }}
            />
            {nameError && (
              <span role="alert" className="text-[12px] text-[#d20b0b]">
                {t('knowledgeAdmin.detail.settings.basicInfo.nameRequired')}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-[6px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.detail.settings.basicInfo.descriptionLabel')}</span>
            <Textarea
              value={description}
              disabled={saving}
              aria-label={t('knowledgeAdmin.detail.settings.basicInfo.descriptionLabel')}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <CapabilityScopeControl value={capabilityScope} onChange={setCapabilityScope} disabled={saving} resourceType="knowledge_base" />
          <div className="flex justify-end">
            <Button
              disabled={saving}
              onClick={() => void saveBasicInfo()}
              className="h-[32px] min-w-[80px] rounded-[10px] bg-[#18181a] px-[12px] text-[14px] font-normal text-white hover:bg-[#303030]"
            >
              {t('common.action.save')}
            </Button>
          </div>
        </div>
      </section>

      <section className={CARD_CLASS} aria-label={t('knowledgeAdmin.detail.settings.onlineStatus.title')}>
        <h2 className="text-[14px] font-semibold text-[#18181a]">{t('knowledgeAdmin.detail.settings.onlineStatus.title')}</h2>
        <div className="mt-[12px] flex items-center justify-between gap-[16px]">
          <p className="text-[12px] leading-[1.6] text-[#858b9c]">
            {isActive
              ? t('knowledgeAdmin.detail.settings.onlineStatus.activeDescription')
              : t('knowledgeAdmin.detail.settings.onlineStatus.archivedDescription')}
          </p>
          <Button
            variant="outline"
            disabled={statusSaving}
            onClick={() => void toggleStatus()}
            className="h-[32px] shrink-0 rounded-[10px] border-[#e3e7f1] px-[14px] text-[12px] font-normal text-[#464c5e] hover:border-[#cbd3e6] hover:text-[#18181a]"
          >
            {isActive ? t('knowledgeAdmin.list.menu.archive') : t('knowledgeAdmin.list.menu.activate')}
          </Button>
        </div>
      </section>

      <section className={`${CARD_CLASS} border-[#f7d3d3]`} aria-label={t('knowledgeAdmin.detail.settings.dangerZone.title')}>
        <h2 className="text-[14px] font-semibold text-[#d20b0b]">{t('knowledgeAdmin.detail.settings.dangerZone.title')}</h2>
        <div className="mt-[12px] flex items-center justify-between gap-[16px]">
          <p className="text-[12px] leading-[1.6] text-[#858b9c]">{t('knowledgeAdmin.detail.settings.dangerZone.description')}</p>
          <Button
            variant="outline"
            onClick={() => setDeleteOpen(true)}
            className="h-[32px] shrink-0 rounded-[10px] border-[#f7d3d3] px-[14px] text-[12px] font-normal text-[#d20b0b] hover:border-[#d20b0b] hover:bg-[#fce7e7]"
          >
            {t('knowledgeAdmin.list.menu.delete')}
          </Button>
        </div>
      </section>

      <DeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        name={kb.name}
        draftCount={draftCount}
        draftCountUnknown={draftCountUnknown}
        loading={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

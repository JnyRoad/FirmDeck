/**
 * 知识库管理 · 私有库详情「内容」Tab（US5，FR-080）：横幅标明当前查看的归属员工、
 * 分支头版本号与同步状态（`kb.branch_sync_state`，复用 `branchSyncMessageId`）；
 * 文档表来自 A2b `listVersionDocuments(kb.id, headVersionId)`（该分支头版本内全部
 * 文档，含未改动的，携带真实行 `id`），headVersionId 取 B2 `listVersions(kb.id,
 * ownerAgentId)` 里 `is_head===true` 的那一条。
 *
 * 上传 / 编辑 / 删除（归档）/ 恢复都带 `ownerAgentId` 调用既有专用库端点
 * （`uploadDocument`/`updateDocument`/`archiveDocument`）；后端 `update_document`
 * 在收到非 overall 的 `agent_id` 时会先把文档克隆进该员工分支的新版本再写入
 * （见 `backend/app/api/knowledge.py::update_document` 的 `knowledge_version_for_upload`
 * 分支），因此任意一次写入都会让分支头版本 +1，写入成功后统一 `reloadAll()`
 * 重新拉取版本与文档列表，让头版本号与列表随之刷新。
 *
 * 编辑正文的还原方式：本分支没有独立的「读取文档正文」端点，`listVersionDocuments`
 * 也不携带正文；这里编辑前用既有单文档端点 `getDocument(docId, ownerAgentId)`
 * 读取 `metadata.raw_text`/`metadata.section_tree`（与 `KnowledgePage.tsx` 的
 * `documentSourceMarkdown` 同一套兜底顺序）尽量还原正文，两者都缺失时以空正文
 * 起草（管理员需要重新输入完整正文）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Dialog, DialogContent, DialogTitle, Input, Textarea } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useAppIntl } from '@/i18n';
import { createMessageDescriptor } from '@/i18n/descriptors';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import {
  DIALOG_CANCEL_BUTTON_CLASS,
  DIALOG_FOOTER_CLASS,
  formatDateTime,
  OUTLINE_ACTION_BUTTON_SM_CLASS,
} from '@/lib/enterprise-ui';
import type { KnowledgeAdminApi } from '@/api/knowledgeAdmin';
import type { KnowledgeBaseRead, KnowledgeDocumentRead } from '@/types';
import type { KnowledgeAdminVersionRead, VersionDocument } from '@/types/knowledgeAdmin';

import { formatVersion } from '../knowledgeAdminModel';
import { useKnowledgeAdminToast } from '../shared/errorMessage';
import { branchSyncMessageId } from './branchStatus';

export type PrivateContentTabProps = {
  api: KnowledgeAdminApi;
  kb: KnowledgeBaseRead;
  /** 本私有库归属员工 id（来自 `kb.metadata.owner_agent_id`），驱动分支范围的写入/查询。 */
  ownerAgentId: string;
  /** 归属员工展示名；横幅"当前查看员工 X"用，缺失时退回 `ownerAgentId`。 */
  ownerAgentName: string;
  onChanged?: () => void;
};

function stringFromMetadata(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** 尽量把一篇文档的正文还原为 markdown：原文优先，其次拼接大纲节点，都没有则空串。 */
function documentSourceMarkdown(document: KnowledgeDocumentRead): string {
  const metadata = document.metadata || {};
  const rawText = stringFromMetadata(metadata.raw_text) || stringFromMetadata(metadata.content);
  if (rawText.trim()) return rawText;
  const sectionTree = Array.isArray(metadata.section_tree) ? metadata.section_tree : [];
  const blocks = sectionTree
    .map((node) => {
      if (!isRecord(node)) return '';
      const content = stringFromMetadata(node.content).trim();
      if (content) return content;
      const title = stringFromMetadata(node.title).trim();
      const summary = stringFromMetadata(node.summary).trim();
      if (title && summary) return `## ${title}\n\n${summary}`;
      return title || summary;
    })
    .filter(Boolean);
  return blocks.join('\n\n');
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 私有库内容 Tab：分支头文档表 + 上传 / 编辑 / 删除 / 恢复，每次写入都产生新分支版本。 */
export function ContentTab({ api, kb, ownerAgentId, ownerAgentName, onChanged }: PrivateContentTabProps) {
  const { t } = useAppIntl();
  const toast = useKnowledgeAdminToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [versions, setVersions] = useState<KnowledgeAdminVersionRead[]>([]);
  const [documents, setDocuments] = useState<VersionDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<VersionDocument | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 编辑框正文是否为空（读取失败，或 `documentSourceMarkdown` 兜底后仍拼不出内容）；
  // 为空时禁止保存并提示，避免管理员在没看到警告的情况下用空正文覆盖真实文档。
  const editContentMissing = Boolean(editTarget) && !editLoading && !editContent.trim();

  const headVersion = useMemo(
    () => versions.find((version) => version.is_head) || versions[0] || null,
    [versions],
  );

  async function loadDocuments(headVersionId: string) {
    try {
      const rows = await api.listVersionDocuments(kb.id, headVersionId);
      setDocuments(Array.isArray(rows) ? rows : []);
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.loadFailed');
    }
  }

  async function reloadAll() {
    if (!ownerAgentId) return;
    setLoading(true);
    try {
      const rows = await api.listVersions(kb.id, ownerAgentId);
      const list = Array.isArray(rows) ? rows : [];
      setVersions(list);
      const head = list.find((version) => version.is_head) || list[0] || null;
      if (head) {
        await loadDocuments(head.id);
      } else {
        setDocuments([]);
      }
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.loadFailed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reloadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, kb.id, ownerAgentId]);

  async function handleUploadFile(file: File) {
    setUploading(true);
    try {
      const contentBase64 = await fileToBase64(file);
      await api.uploadDocument(
        { knowledgeBaseId: kb.id, filename: file.name, contentBase64, title: file.name },
        ownerAgentId,
      );
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.uploadSuccess'));
      await reloadAll();
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function openEdit(document: VersionDocument) {
    setEditTarget(document);
    setEditTitle(document.title);
    setEditContent('');
    setEditLoading(true);
    try {
      const full = await api.getDocument(document.id, ownerAgentId);
      setEditContent(documentSourceMarkdown(full));
    } catch {
      // 单篇正文读取失败不阻塞编辑框：留空正文，管理员可以重新输入。
    } finally {
      setEditLoading(false);
    }
  }

  async function handleSaveEdit() {
    if (!editTarget) return;
    setSaving(true);
    try {
      await api.updateDocument(
        editTarget.id,
        { title: editTitle, contentMd: editContent, expectedUpdatedAt: editTarget.updated_at },
        ownerAgentId,
      );
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.updateSuccess'));
      setEditTarget(null);
      await reloadAll();
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(document: VersionDocument) {
    setBusyId(document.id);
    try {
      await api.archiveDocument(document.id, { expectedUpdatedAt: document.updated_at }, ownerAgentId);
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.archiveDocumentSuccess'));
      await reloadAll();
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.deleteError');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRestore(document: VersionDocument) {
    setBusyId(document.id);
    try {
      await api.updateDocument(document.id, { status: 'ready', expectedUpdatedAt: document.updated_at }, ownerAgentId);
      toast.success(createMessageDescriptor('knowledgeAdmin.toast.restoreDocumentSuccess'));
      await reloadAll();
      onChanged?.();
    } catch (error) {
      toast.error(error, 'knowledgeAdmin.toast.updateError');
    } finally {
      setBusyId(null);
    }
  }

  const columns: DataTableColumn<VersionDocument>[] = [
    {
      key: 'title',
      title: t('knowledgeAdmin.content.table.title'),
      render: (row) => <RawContent value={row.title} />,
    },
    {
      key: 'status',
      title: t('knowledgeAdmin.content.table.status'),
      width: 120,
      render: (row) => (
        <span className="rounded-full bg-[#eef2f7] px-[8px] py-[2px] text-[11px] font-medium text-[#596174]">
          <RawContent value={row.status} />
        </span>
      ),
    },
    {
      key: 'updatedAt',
      title: t('knowledgeAdmin.list.columns.updatedAt'),
      width: 160,
      render: (row) => formatDateTime(row.updated_at),
    },
    {
      key: 'actions',
      title: t('knowledgeAdmin.content.table.actions'),
      width: 160,
      align: 'right',
      render: (row) =>
        row.status === 'archived' ? (
          <Button
            variant="outline"
            disabled={busyId === row.id}
            onClick={() => void handleRestore(row)}
            className={OUTLINE_ACTION_BUTTON_SM_CLASS}
          >
            {t('knowledgeAdmin.content.actions.restore')}
          </Button>
        ) : (
          <div className="flex justify-end gap-[6px]">
            <Button
              variant="outline"
              disabled={busyId === row.id}
              onClick={() => void openEdit(row)}
              className={OUTLINE_ACTION_BUTTON_SM_CLASS}
            >
              {t('knowledgeAdmin.private.content.actions.edit')}
            </Button>
            <Button
              variant="outline"
              disabled={busyId === row.id}
              onClick={() => void handleDelete(row)}
              className={OUTLINE_ACTION_BUTTON_SM_CLASS}
            >
              {t('knowledgeAdmin.content.actions.delete')}
            </Button>
          </div>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-wrap items-center justify-between gap-[10px] rounded-[12px] border-[0.5px] border-[#e3e7f1] bg-[#f7f8fa] px-[14px] py-[10px]">
        <p className="text-[12px] text-[#464c5e]">
          {t('knowledgeAdmin.private.content.banner.viewingPrefix')}
          <RawIdentifier value={ownerAgentName || ownerAgentId} />
          {t('knowledgeAdmin.private.content.banner.viewingSuffix', {
            version: formatVersion(headVersion?.version),
          })}
          <span className="ml-[8px] text-[#858b9c]">{t(branchSyncMessageId(kb.branch_sync_state))}</span>
        </p>
        <div className="flex items-center gap-[8px]">
          <input
            ref={fileInputRef}
            type="file"
            data-testid="private-content-upload-input"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleUploadFile(file);
            }}
          />
          <Button
            disabled={uploading || !ownerAgentId}
            onClick={() => fileInputRef.current?.click()}
            className="h-[30px] rounded-[9px] bg-[#18181a] px-[14px] text-[12px] text-white hover:bg-[#303030]"
          >
            {t('knowledgeAdmin.content.actions.upload')}
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={documents}
        rowKey={(row) => row.id}
        loading={loading}
        emptyText={t('knowledgeAdmin.content.empty')}
        aria-label={t('knowledgeAdmin.detail.tabs.content')}
      />

      <Dialog open={Boolean(editTarget)} onOpenChange={(next) => !saving && !next && setEditTarget(null)}>
        <DialogContent className="w-[min(640px,calc(100vw-32px))] gap-0 overflow-hidden rounded-[16px] border-0 bg-white p-0 shadow-[0px_12px_32px_rgba(0,0,0,0.16)]">
          <DialogTitle className="px-[24px] pt-[20px] pb-[12px] text-[16px] font-semibold text-[#18181a]">
            {t('knowledgeAdmin.private.content.editDialog.title')}
          </DialogTitle>
          <div className="flex flex-col gap-[10px] px-[24px] pb-[16px]">
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.private.content.editDialog.titleLabel')}</span>
            <Input
              value={editTitle}
              disabled={saving || editLoading}
              aria-label={t('knowledgeAdmin.private.content.editDialog.titleLabel')}
              onChange={(event) => setEditTitle(event.target.value)}
            />
            <span className="text-[12px] font-medium text-[#464c5e]">{t('knowledgeAdmin.private.content.editDialog.contentLabel')}</span>
            <Textarea
              value={editContent}
              disabled={saving || editLoading}
              aria-label={t('knowledgeAdmin.private.content.editDialog.contentLabel')}
              className="min-h-[220px]"
              onChange={(event) => setEditContent(event.target.value)}
            />
            {editContentMissing && (
              <p role="alert" className="rounded-[8px] bg-[#fff4e5] px-[10px] py-[8px] text-[12px] text-[#a15c00]">
                {t('knowledgeAdmin.private.content.editDialog.contentMissingWarning')}
              </p>
            )}
          </div>
          <div className={DIALOG_FOOTER_CLASS}>
            <Button variant="outline" disabled={saving} onClick={() => setEditTarget(null)} className={DIALOG_CANCEL_BUTTON_CLASS}>
              {t('knowledgeAdmin.private.content.editDialog.cancel')}
            </Button>
            <Button
              disabled={saving || editLoading || editContentMissing}
              onClick={() => void handleSaveEdit()}
              className="h-[32px] min-w-[80px] rounded-[10px] bg-[#18181a] px-[12px] text-[14px] font-normal text-white hover:bg-[#303030]"
            >
              {t('knowledgeAdmin.private.content.editDialog.save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

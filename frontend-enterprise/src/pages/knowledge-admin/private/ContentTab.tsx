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
import { useGuardedLoad } from '../shared/useGuardedLoad';
import { branchSyncMessageId } from './branchStatus';

export type PrivateContentTabProps = {
  api: KnowledgeAdminApi;
  kb: KnowledgeBaseRead;
  /** 本私有库归属员工 id（来自 `kb.metadata.owner_agent_id`），驱动分支范围的写入/查询。 */
  ownerAgentId: string;
  /** 归属员工展示名；横幅「员工：X」用，缺失时退回 `ownerAgentId`。 */
  ownerAgentName: string;
  onChanged?: () => void;
};

/** 文档状态枚举 → 语义消息 id（I8）。 */
const DOCUMENT_STATUS_LABEL_IDS: Record<
  string,
  'knowledgeAdmin.private.content.documentStatus.ready' | 'knowledgeAdmin.private.content.documentStatus.archived'
> = {
  ready: 'knowledgeAdmin.private.content.documentStatus.ready',
  archived: 'knowledgeAdmin.private.content.documentStatus.archived',
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
  // 过期响应护栏（I1）：分支版本列表 + 文档列表 + 单篇编辑各一条请求序号线。
  const reloadGuard = useGuardedLoad();
  const documentsLoad = useGuardedLoad();
  /**
   * 编辑框的请求序号线：`openEdit` 里的 `getDocument` 是异步的，快速点开 A 再点开 B
   * （或点开后立刻关掉）时，A 的迟到响应会把正文灌进为 B 打开的对话框——保存下去就是
   * 拿 A 的正文覆盖 B。开与关都占用一个新序号，只有当前这次打开的响应才允许落地。
   */
  const editLoad = useGuardedLoad();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [versions, setVersions] = useState<KnowledgeAdminVersionRead[]>([]);
  const [documents, setDocuments] = useState<VersionDocument[]>([]);
  /**
   * 文档表是否正在（重新）加载。与 `loading`（分支版本列表）分开：版本列表回来之后
   * 还要再打一次文档列表，这段空窗期里表格必须继续显示加载中、行级操作必须禁用，
   * 否则管理员会对着上一个分支头的文档按删除/编辑——那些 id 已经不属于新的头版本。
   */
  const [documentsLoading, setDocumentsLoading] = useState(false);
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
    const token = documentsLoad.begin();
    setDocumentsLoading(true);
    try {
      const rows = await api.listVersionDocuments(kb.id, headVersionId);
      // 过期响应（切换归属员工 / 租户代际已变）整个丢弃，见 useGuardedLoad（I1）。
      if (!documentsLoad.isCurrent(token)) return;
      setDocuments(Array.isArray(rows) ? rows : []);
    } catch (error) {
      if (!documentsLoad.isCurrent(token)) return;
      setDocuments([]);
      toast.error(error, 'knowledgeAdmin.toast.loadFailed');
    } finally {
      if (documentsLoad.isCurrent(token)) setDocumentsLoading(false);
    }
  }

  async function reloadAll() {
    if (!ownerAgentId) return;
    const token = reloadGuard.begin();
    // 版本列表一开始重拉，上一轮的文档请求就已经过期了：立刻占号作废它，并清空表格。
    // 私有库每次写入都会让分支头 +1，旧头版本的文档 id 拿去删除/恢复会打到错误的对象；
    // 这段空窗里表格保持加载中、行级操作禁用，直到新头版本的文档到手。
    documentsLoad.begin();
    setDocuments([]);
    setDocumentsLoading(true);
    setLoading(true);
    try {
      const rows = await api.listVersions(kb.id, ownerAgentId);
      if (!reloadGuard.isCurrent(token)) return;
      const list = Array.isArray(rows) ? rows : [];
      setVersions(list);
      const head = list.find((version) => version.is_head) || list[0] || null;
      if (head) {
        await loadDocuments(head.id);
      } else {
        setDocuments([]);
        setDocumentsLoading(false);
      }
    } catch (error) {
      if (!reloadGuard.isCurrent(token)) return;
      setDocumentsLoading(false);
      toast.error(error, 'knowledgeAdmin.toast.loadFailed');
    } finally {
      if (reloadGuard.isCurrent(token)) setLoading(false);
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

  /** 关闭编辑框：同时作废在途的 `getDocument`，避免它回来后往已关闭/已换目标的框里灌正文。 */
  function closeEdit() {
    editLoad.begin();
    setEditTarget(null);
  }

  async function openEdit(document: VersionDocument) {
    const token = editLoad.begin();
    setEditTarget(document);
    setEditTitle(document.title);
    setEditContent('');
    setEditLoading(true);
    try {
      const full = await api.getDocument(document.id, ownerAgentId);
      // 这次响应已经不是当前打开的那一篇（期间又点开了别的文档，或框已关闭）：整个丢弃。
      if (!editLoad.isCurrent(token)) return;
      setEditContent(documentSourceMarkdown(full));
    } catch {
      // 单篇正文读取失败不阻塞编辑框：留空正文，管理员可以重新输入。
    } finally {
      if (editLoad.isCurrent(token)) setEditLoading(false);
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
      closeEdit();
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
      // I8：`ready`/`archived` 是 FirmDeck 自己的文档状态枚举，不是用户原文——
      // 必须本地化，且不该套 `RawContent`（那是 raw 内容边界标记）。落键模式同
      // `VersionsTab.tsx` 的 `STATE_LABEL_IDS`；未登记的新状态原样显示码本身。
      render: (row) => {
        const labelId = DOCUMENT_STATUS_LABEL_IDS[row.status];
        return (
          <span className="rounded-full bg-[#eef2f7] px-[8px] py-[2px] text-[11px] font-medium text-[#596174]">
            {labelId ? t(labelId) : row.status}
          </span>
        );
      },
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
            disabled={busyId === row.id || documentsLoading}
            onClick={() => void handleRestore(row)}
            className={OUTLINE_ACTION_BUTTON_SM_CLASS}
          >
            {t('knowledgeAdmin.content.actions.restore')}
          </Button>
        ) : (
          <div className="flex justify-end gap-[6px]">
            <Button
              variant="outline"
              disabled={busyId === row.id || documentsLoading}
              onClick={() => void openEdit(row)}
              className={OUTLINE_ACTION_BUTTON_SM_CLASS}
            >
              {t('knowledgeAdmin.private.content.actions.edit')}
            </Button>
            <Button
              variant="outline"
              disabled={busyId === row.id || documentsLoading}
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
        {/*
          I7：原来是 `viewingPrefix` + 原始员工名 + `viewingSuffix` 三段拼一句话
          （en 的后半段以属格撇号 `’s` 直接粘在后端返回的名字上），既钉死了词序也
          让译者拿不到完整句子。这里改成两个各自完整的短语：「标签 + 原始员工名」的
          标签-值对，和一句独立的分支头版本说明——两种语言都能各自组织语序，
          `RawIdentifier` 仍然只包住员工名本身这个 raw 边界。
        */}
        <div className="flex flex-wrap items-center gap-[8px] text-[12px] text-[#464c5e]">
          <span className="flex items-center gap-[4px]">
            {t('knowledgeAdmin.private.content.banner.ownerLabel')}
            <RawIdentifier value={ownerAgentName || ownerAgentId} />
          </span>
          <span>
            {t('knowledgeAdmin.private.content.banner.branchHead', {
              version: formatVersion(headVersion?.version),
            })}
          </span>
          <span className="text-[#858b9c]">{t(branchSyncMessageId(kb.branch_sync_state))}</span>
        </div>
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
            className="h-[30px] rounded-[9px] bg-primary px-[14px] text-[12px] text-white hover:bg-primary/80"
          >
            {t('knowledgeAdmin.content.actions.upload')}
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={documents}
        rowKey={(row) => row.id}
        loading={loading || documentsLoading}
        emptyText={t('knowledgeAdmin.content.empty')}
        aria-label={t('knowledgeAdmin.detail.tabs.content')}
      />

      <Dialog open={Boolean(editTarget)} onOpenChange={(next) => !saving && !next && closeEdit()}>
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
            <Button variant="outline" disabled={saving} onClick={closeEdit} className={DIALOG_CANCEL_BUTTON_CLASS}>
              {t('knowledgeAdmin.private.content.editDialog.cancel')}
            </Button>
            <Button
              disabled={saving || editLoading || editContentMissing}
              onClick={() => void handleSaveEdit()}
              className="h-[32px] min-w-[80px] rounded-[10px] bg-primary px-[12px] text-[14px] font-normal text-white hover:bg-primary/80"
            >
              {t('knowledgeAdmin.private.content.editDialog.save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

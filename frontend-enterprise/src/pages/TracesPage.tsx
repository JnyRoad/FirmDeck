/** Trace 列表页：产品 chrome 由语义 i18n 投影，trace 标识和诊断 payload 保持 raw。 */

import { ReloadOutlined } from '../icons';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Button as UIButton,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui';
import { createToastNotifier } from '@/components/ui/app-toast';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Paginator } from '@/components/Paginator';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { MessageId } from '@/i18n/types';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';
import { useClientPagination } from '../hooks/useClientPagination';
import { api, TENANT_ID } from '../api/client';
import type { TraceSummary } from '../types';

const TRACES_PAGE_SIZE = 10;

const TRACE_MESSAGE_IDS = {
  pageTitleId: 'chat.trace.executionRecord',
  refreshId: 'modelsPage.actions.refresh',
  cardTitleId: 'shell.nav.conversationLogs',
  emptyId: 'scheduledTasksPage.empty.none',
  paginationId: 'scheduledTasksPage.section.paginationAria',
  detailTitleId: 'teamDetailPage.section.executionReport',
  sessionId: 'scheduledTasksPage.column.session',
  userId: 'sharedKnowledgeVersions.audit.actorId',
  skillId: 'distillPage.field.skillId',
  stepId: 'distillPage.field.stepId',
  toolId: 'runtimeSettings.field.showToolTrace',
  statusId: 'scheduledTasksPage.column.status',
  updatedId: 'accountsPage.column.updatedAt',
  actionsId: 'accountsPage.column.actions',
  viewId: 'knowledgePage.actions.details',
  loadFailedId: 'chat.error.traceLoad',
} as const satisfies Record<string, MessageId>;

/** 将 trace API 错误投影为稳定 descriptor，未知异常只走安全的本地化 fallback。 */
function traceErrorDescriptor(error: unknown): MessageDescriptor {
  const descriptor = backendErrorMessageDescriptor(error);
  return descriptor
    ? { id: descriptor.messageId, values: descriptor.values }
    : createMessageDescriptor(TRACE_MESSAGE_IDS.loadFailedId);
}

/** 渲染可选 raw 标识；缺失值使用产品空值文案，不把业务数据送入翻译器。 */
function rawIdentifierOrEmpty(value: string | undefined, emptyLabel: string): ReactNode {
  return value ? <RawIdentifier value={value} /> : emptyLabel;
}

/** 渲染 trace 状态或数字原值，并用精确 raw marker 阻止 locale 改写。 */
function rawTraceValue(value: string | number): ReactNode {
  return <RawContent value={String(value)} />;
}

/** 将 trace 详情序列化为只读 raw 文本；对象无法序列化时返回空值而不伪造产品文案。 */
function serializeTraceDetail(value: Record<string, unknown> | null): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

/** 渲染 trace 列表与详情抽屉；请求失败只显示稳定的本地化产品错误。 */
export default function TracesPage() {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const [rows, setRows] = useState<TraceSummary[]>([]);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);

  /** 加载 trace 摘要；异常根因只记录到诊断日志，不进入 toast。 */
  async function load() {
    try {
      const result = await api.get<TraceSummary[]>(`/api/enterprise/traces?tenant_id=${TENANT_ID}`);
      setRows(result);
    } catch (error) {
      console.error('[traces-page] list load failed', error);
      toast.error(traceErrorDescriptor(error));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const pagination = useClientPagination(rows, TRACES_PAGE_SIZE);

  /** 打开单条 trace 详情；原始 payload 交给 raw 展示边界。 */
  async function openDetail(row: TraceSummary) {
    try {
      const result = await api.get<Record<string, unknown>>(`/api/enterprise/traces/${row.session_id}?tenant_id=${TENANT_ID}`);
      setDetail(result);
    } catch (error) {
      console.error('[traces-page] detail load failed', error);
      toast.error(traceErrorDescriptor(error));
    }
  }

  const truncateCell = 'block truncate';
  const columns: DataTableColumn<TraceSummary>[] = [
    {
      key: 'session_id',
      title: t(TRACE_MESSAGE_IDS.sessionId),
      width: 230,
      render: (row) => <span className={truncateCell}><RawIdentifier value={row.session_id} /></span>,
    },
    {
      key: 'user_id',
      title: t(TRACE_MESSAGE_IDS.userId),
      width: 150,
      render: (row) => <span className={truncateCell}>{rawIdentifierOrEmpty(row.user_id, t(TRACE_MESSAGE_IDS.emptyId))}</span>,
    },
    {
      key: 'active_skill_id',
      title: t(TRACE_MESSAGE_IDS.skillId),
      width: 190,
      render: (row) => <span className={truncateCell}>{rawIdentifierOrEmpty(row.active_skill_id, t(TRACE_MESSAGE_IDS.emptyId))}</span>,
    },
    {
      key: 'active_step_id',
      title: t(TRACE_MESSAGE_IDS.stepId),
      width: 190,
      render: (row) => <span className={truncateCell}>{rawIdentifierOrEmpty(row.active_step_id, t(TRACE_MESSAGE_IDS.emptyId))}</span>,
    },
    { key: 'tool_call_count', title: t(TRACE_MESSAGE_IDS.toolId), width: 96, render: (row) => rawTraceValue(row.tool_call_count) },
    { key: 'status', title: t(TRACE_MESSAGE_IDS.statusId), width: 96, render: (row) => rawTraceValue(row.status) },
    {
      key: 'updated_at',
      title: t(TRACE_MESSAGE_IDS.updatedId),
      width: 210,
      render: (row) => <span className={truncateCell}>{rawTraceValue(row.updated_at)}</span>,
    },
    {
      key: 'actions',
      title: t(TRACE_MESSAGE_IDS.actionsId),
      width: 96,
      render: (row) => (
        <UIButton
          variant="outline"
          size="sm"
          className="h-[28px] rounded-[8px] px-[12px] text-[12px]"
          onClick={() => void openDetail(row)}
        >
          {t(TRACE_MESSAGE_IDS.viewId)}
        </UIButton>
      ),
    },
  ];

  return (
    <>
      <div className="page-title">
        <h3>{t(TRACE_MESSAGE_IDS.pageTitleId)}</h3>
        <UIButton variant="outline" onClick={() => void load()}>
          <ReloadOutlined />
          {t(TRACE_MESSAGE_IDS.refreshId)}
        </UIButton>
      </div>
      <Card className="data-card">
        <CardHeader>
          <CardTitle>{t(TRACE_MESSAGE_IDS.cardTitleId)}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-[16px]">
          <div className="overflow-x-auto">
            <DataTable
              aria-label={t(TRACE_MESSAGE_IDS.cardTitleId)}
              columns={columns}
              data={pagination.pagedItems}
              rowKey={(row) => row.session_id}
              className="min-w-[1308px]"
              emptyText={t(TRACE_MESSAGE_IDS.emptyId)}
            />
          </div>
          {rows.length > 0 && (
            <Paginator
              aria-label={t(TRACE_MESSAGE_IDS.paginationId, { title: t(TRACE_MESSAGE_IDS.cardTitleId) })}
              className="mt-0"
              page={pagination.page}
              pageCount={pagination.pageCount}
              onChange={pagination.setPage}
            />
          )}
        </CardContent>
      </Card>
      <Sheet open={Boolean(detail)} onOpenChange={(next) => { if (!next) setDetail(null); }}>
        <SheetContent side="right" className="w-[720px] sm:max-w-[720px]">
          <SheetHeader>
            <SheetTitle>{t(TRACE_MESSAGE_IDS.detailTitleId)}</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-auto px-[16px] pb-[16px]">
            <pre className="text-[12px] whitespace-pre-wrap">
              <RawContent value={serializeTraceDetail(detail)} />
            </pre>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

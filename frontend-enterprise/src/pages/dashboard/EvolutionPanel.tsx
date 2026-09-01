import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button, notify } from '@/components/ui';
import StaffdeckIcon from '@/components/StaffdeckIcon';
import { createTenantClient } from '@/api/tenant-client';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import type { AppTranslator } from '@/i18n/imperative';
import { useAppIntl } from '@/i18n/useAppIntl';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import type { MessageId } from '@/i18n/types';

type EvolutionProposal = {
  id: string;
  resource_type: 'sop' | 'general_skill';
  resource_name: string;
  resource_key: string;
  base_version?: string | null;
  status: string;
  risk_level: string;
  hypothesis: string;
  rationale: string;
  expected_outcome: string;
  source_feedback_ids: string[];
  evidence: Array<Record<string, unknown>>;
  diff: Array<{ op?: string; path?: string; before?: unknown; after?: unknown }>;
  evaluation: Record<string, unknown>;
  created_at: string;
};

const EVOLUTION_STATUS_IDS = {
  ready_for_review: 'dashboard.evolution.status.readyForReview',
  evaluation_failed: 'dashboard.evolution.status.evaluationFailed',
  published: 'dashboard.evolution.status.published',
  rejected: 'dashboard.evolution.status.rejected',
  rolled_back: 'dashboard.evolution.status.rolledBack',
} as const satisfies Partial<Record<string, MessageId>>;

const EVOLUTION_RISK_IDS = {
  low: 'dashboard.evolution.risk.low',
  medium: 'dashboard.evolution.risk.medium',
  high: 'dashboard.evolution.risk.high',
} as const satisfies Partial<Record<string, MessageId>>;

const EVOLUTION_ACTION_SUCCESS_IDS = {
  analyze: 'dashboard.evolution.toast.analyzeSuccess',
  evaluate: 'dashboard.evolution.toast.evaluateSuccess',
  approve: 'dashboard.evolution.toast.approveSuccess',
  reject: 'dashboard.evolution.toast.rejectSuccess',
  rollback: 'dashboard.evolution.toast.rollbackSuccess',
} as const satisfies Record<'analyze' | 'evaluate' | 'approve' | 'reject' | 'rollback', MessageId>;

const EVOLUTION_ACTION_ERROR_IDS = {
  load: 'dashboard.evolution.error.load',
  analyze: 'dashboard.evolution.error.analyze',
  evaluate: 'dashboard.evolution.error.evaluate',
  approve: 'dashboard.evolution.error.approve',
  reject: 'dashboard.evolution.error.reject',
  rollback: 'dashboard.evolution.error.rollback',
} as const satisfies Record<'load' | 'analyze' | 'evaluate' | 'approve' | 'reject' | 'rollback', MessageId>;

const REJECT_REASON = 'Rejected in employee dashboard review';

/** 将错误收敛到 catalog 语义文案；未知错误不展示原始 message。 */
function evolutionErrorMessage(
  error: unknown,
  fallbackId: MessageId,
  translate: AppTranslator['t'],
): string {
  const genericMessage = translate('common.error.generic');
  const message = apiErrorMessage(error, fallbackId, { t: translate });
  return message === genericMessage ? translate(fallbackId) : message;
}

/** 返回提案状态的语义标签，未知状态精确落到 raw identifier。 */
function evolutionStatusLabel(
  status: string,
  translate: AppTranslator['t'],
): string {
  const messageId = EVOLUTION_STATUS_IDS[status as keyof typeof EVOLUTION_STATUS_IDS];
  return messageId ? translate(messageId) : status;
}

/** 返回风险等级的语义标签，未知等级保持原始值。 */
function evolutionRiskLabel(
  risk: string,
  translate: AppTranslator['t'],
): string {
  const messageId = EVOLUTION_RISK_IDS[risk as keyof typeof EVOLUTION_RISK_IDS];
  return messageId ? translate(messageId) : risk;
}

/** 将候选资源类型投影为当前 locale 的产品文案。 */
function evolutionResourceTypeLabel(
  type: EvolutionProposal['resource_type'],
  translate: AppTranslator['t'],
): string {
  return translate(type === 'sop' ? 'dashboard.evolution.resourceType.sop' : 'dashboard.evolution.resourceType.skill');
}

export default function EvolutionPanel({ agentId }: { agentId: string }) {
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const loadControllerRef = useRef<AbortController | null>(null);
  const agentIdRef = useRef(agentId);
  const lastAgentIdRef = useRef(agentId);
  const scopeRevisionRef = useRef(0);
  const actionControllersRef = useRef(new Set<AbortController>());
  const [rows, setRows] = useState<EvolutionProposal[]>([]);
  const [instruction, setInstruction] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState('');

  // Keep the latest prop visible to an in-flight callback before passive effects run.
  agentIdRef.current = agentId;

  /** Abort action requests when employee scope, tenant generation, or component lifecycle changes. */
  function cancelActionControllers() {
    actionControllersRef.current.forEach((controller) => controller.abort());
    actionControllersRef.current.clear();
  }

  useEffect(() => {
    if (lastAgentIdRef.current === agentId) return;
    lastAgentIdRef.current = agentId;
    scopeRevisionRef.current += 1;
    cancelActionControllers();
    setRows([]);
    setBusyAction('');
  }, [agentId]);

  useEffect(() => () => cancelActionControllers(), [tenantContext?.generation]);

  const load = useCallback(async () => {
    if (!tenantContext || !tenantId || !userId) return;
    loadControllerRef.current?.abort();
    const requestController = new AbortController();
    loadControllerRef.current = requestController;
    const generation = tenantContext.generation;
    const capturedAgentId = agentId;
    const capturedScopeRevision = scopeRevisionRef.current;
    const isCurrent = () => (
      !requestController.signal.aborted
      && tenantContext.isCurrentGeneration(generation)
      && agentIdRef.current === capturedAgentId
      && scopeRevisionRef.current === capturedScopeRevision
    );
    setLoading(true);
    try {
      const result = await tenantClient.get<EvolutionProposal[]>(
        `/api/enterprise/agents/${encodeURIComponent(agentId)}/evolution/proposals`,
        { signal: requestController.signal },
      );
      if (!isCurrent()) return;
      setRows(result);
    } catch (error) {
      if (isCurrent()) notify.error(evolutionErrorMessage(error, EVOLUTION_ACTION_ERROR_IDS.load, t));
    } finally {
      if (loadControllerRef.current === requestController) {
        loadControllerRef.current = null;
        if (isCurrent()) setLoading(false);
      }
    }
  }, [agentId, t, tenantClient, tenantContext, tenantId, userId]);

  useEffect(() => {
    void load();
    return () => {
      loadControllerRef.current?.abort();
    };
  }, [load]);

  const activeCount = useMemo(
    () => rows.filter((item) => ['ready_for_review', 'evaluation_failed'].includes(item.status)).length,
    [rows],
  );

  /** 从真实反馈生成候选，并在成功后刷新列表。 */
  async function analyze() {
    if (!tenantContext || !tenantId || !userId) return;
    const requestController = new AbortController();
    actionControllersRef.current.add(requestController);
    const generation = tenantContext.generation;
    const capturedAgentId = agentId;
    const capturedScopeRevision = scopeRevisionRef.current;
    const isCurrent = () => (
      !requestController.signal.aborted
      && tenantContext.isCurrentGeneration(generation)
      && agentIdRef.current === capturedAgentId
      && scopeRevisionRef.current === capturedScopeRevision
    );
    setBusyAction('analyze');
    try {
      await tenantClient.post(
        `/api/enterprise/agents/${encodeURIComponent(agentId)}/evolution:analyze`,
        { instruction: instruction.trim() || undefined },
        { signal: requestController.signal },
      );
      if (!isCurrent()) return;
      setInstruction('');
      notify.successText(t(EVOLUTION_ACTION_SUCCESS_IDS.analyze));
      if (!isCurrent()) return;
      await load();
    } catch (error) {
      if (isCurrent()) notify.error(evolutionErrorMessage(error, EVOLUTION_ACTION_ERROR_IDS.analyze, t));
    } finally {
      if (isCurrent()) setBusyAction('');
      actionControllersRef.current.delete(requestController);
    }
  }

  /** 对候选执行审核动作；拒绝原因使用稳定英文诊断值，不进入本地化目录。 */
  async function act(proposal: EvolutionProposal, action: 'evaluate' | 'approve' | 'reject' | 'rollback') {
    if (!tenantContext || !tenantId || !userId) return;
    const requestController = new AbortController();
    actionControllersRef.current.add(requestController);
    const generation = tenantContext.generation;
    const capturedAgentId = agentId;
    const capturedScopeRevision = scopeRevisionRef.current;
    const isCurrent = () => (
      !requestController.signal.aborted
      && tenantContext.isCurrentGeneration(generation)
      && agentIdRef.current === capturedAgentId
      && scopeRevisionRef.current === capturedScopeRevision
    );
    const key = `${proposal.id}:${action}`;
    setBusyAction(key);
    try {
      const body = action === 'reject'
        ? { reason: REJECT_REASON }
        : {};
      await tenantClient.post(
        `/api/enterprise/evolution/proposals/${encodeURIComponent(proposal.id)}:${action}`,
        body,
        { signal: requestController.signal },
      );
      if (!isCurrent()) return;
      notify.successText(t(EVOLUTION_ACTION_SUCCESS_IDS[action]));
      if (!isCurrent()) return;
      await load();
    } catch (error) {
      if (isCurrent()) notify.error(evolutionErrorMessage(error, EVOLUTION_ACTION_ERROR_IDS[action], t));
    } finally {
      if (isCurrent()) setBusyAction('');
      actionControllersRef.current.delete(requestController);
    }
  }

  return (
    <section className="mt-[20px] rounded-[22px] border border-[#e5e9f2] bg-white p-[20px] shadow-[0_10px_30px_rgba(31,42,68,0.04)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-xl bg-[#ecfbf5] text-[#168760]">
              <StaffdeckIcon name="spark" />
            </span>
            <h3 className="m-0 text-[16px] font-semibold text-[#202226]">
              {t('dashboard.evolution.title')}
            </h3>
            {activeCount > 0 && (
              <span className="rounded-full bg-[#fff4da] px-2 py-0.5 text-[11px] text-[#9a6a08]">
                {t('dashboard.evolution.pendingCount', { count: activeCount })}
              </span>
            )}
          </div>
          <p className="mt-2 mb-0 max-w-[760px] text-[13px] leading-5 text-[#7b8499]">
            {t('dashboard.evolution.description')}
          </p>
        </div>
        <Button
          disabled={busyAction !== ''}
          onClick={() => void analyze()}
          aria-label={t('dashboard.evolution.actions.analyze')}
        >
          {busyAction === 'analyze'
            ? t('dashboard.evolution.actions.analyzing')
            : t('dashboard.evolution.actions.analyze')}
        </Button>
      </div>

      <textarea
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder={t('dashboard.evolution.instructionPlaceholder')}
        aria-label={t('dashboard.evolution.instructionLabel')}
        className="mt-4 min-h-[66px] w-full resize-y rounded-xl border border-[#e4e8f0] bg-[#fafbfc] px-3 py-2 text-[13px] leading-5 text-[#313642] outline-none focus:border-[#8fd6bb]"
      />

      <div className="mt-4 grid gap-3">
        {!loading && rows.length === 0 && (
          <div className="rounded-xl border border-dashed border-[#dfe4ec] px-4 py-5 text-center text-[13px] text-[#8b94a8]">
            {t('dashboard.evolution.empty')}
          </div>
        )}
        {rows.map((proposal) => {
          const passed = proposal.evaluation?.passed === true;
          return (
            <article key={proposal.id} className="rounded-2xl border border-[#e7eaf0] bg-[#fcfcfd] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-[14px] text-[#202226]">
                      <RawContent value={proposal.resource_name} />
                    </strong>
                    <span className="rounded-full bg-[#eef2f8] px-2 py-0.5 text-[11px] text-[#657087]">
                      {evolutionResourceTypeLabel(proposal.resource_type, t)}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${riskClass(proposal.risk_level)}`}>
                      {EVOLUTION_RISK_IDS[proposal.risk_level as keyof typeof EVOLUTION_RISK_IDS]
                        ? evolutionRiskLabel(proposal.risk_level, t)
                        : <RawIdentifier value={proposal.risk_level} />}
                    </span>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-[#657087] ring-1 ring-[#e1e5ec]">
                      {EVOLUTION_STATUS_IDS[proposal.status as keyof typeof EVOLUTION_STATUS_IDS]
                        ? evolutionStatusLabel(proposal.status, t)
                        : <RawIdentifier value={proposal.status} />}
                    </span>
                  </div>
                  <p className="mt-2 mb-0 text-[13px] font-medium text-[#444b59]">
                    <RawContent value={proposal.hypothesis} />
                  </p>
                  <p className="mt-1 mb-0 text-[12px] leading-5 text-[#7b8499]">
                    {t('dashboard.evolution.summary', {
                      feedbackCount: (proposal.source_feedback_ids ?? []).length,
                      diffCount: (proposal.diff ?? []).length,
                      validation: passed
                        ? t('dashboard.evolution.validation.passed')
                        : t('dashboard.evolution.validation.pending'),
                    })}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {['ready_for_review', 'evaluation_failed'].includes(proposal.status) && (
                    <>
                      <Button
                        variant="outline"
                        disabled={busyAction !== ''}
                        onClick={() => void act(proposal, 'evaluate')}
                      >
                        {t('dashboard.evolution.actions.evaluate')}
                      </Button>
                      <Button
                        disabled={busyAction !== ''}
                        onClick={() => void act(proposal, 'approve')}
                      >
                        {t('dashboard.evolution.actions.approve')}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busyAction !== ''}
                        onClick={() => void act(proposal, 'reject')}
                      >
                        {t('dashboard.evolution.actions.reject')}
                      </Button>
                    </>
                  )}
                  {proposal.status === 'published' && (
                    <Button
                      variant="outline"
                      disabled={busyAction !== ''}
                      onClick={() => void act(proposal, 'rollback')}
                    >
                      {t('dashboard.evolution.actions.rollback')}
                    </Button>
                  )}
                </div>
              </div>
              <details className="mt-3 rounded-xl bg-white px-3 py-2 ring-1 ring-[#edf0f4]">
                <summary className="cursor-pointer text-[12px] text-[#5f6b80]">
                  {t('dashboard.evolution.details.toggle')}
                </summary>
                <div className="mt-3 grid gap-3 text-[12px] leading-5 text-[#667085]">
                  <div>
                    <strong className="text-[#394150]">{t('dashboard.evolution.details.rationale')}</strong>
                    <p className="mt-1 mb-0 whitespace-pre-wrap">
                      {proposal.rationale ? <RawContent value={proposal.rationale} /> : t('dashboard.evolution.none')}
                    </p>
                  </div>
                  <div>
                    <strong className="text-[#394150]">{t('dashboard.evolution.details.expectedOutcome')}</strong>
                    <p className="mt-1 mb-0">
                      {proposal.expected_outcome
                        ? <RawContent value={proposal.expected_outcome} />
                        : t('dashboard.evolution.none')}
                    </p>
                  </div>
                  <div>
                    <strong className="text-[#394150]">{t('dashboard.evolution.details.diff')}</strong>
                    <div className="mt-1 max-h-[240px] overflow-auto rounded-lg bg-[#f7f8fa] p-2 font-mono text-[11px]">
                      {(proposal.diff ?? []).length === 0 ? t('dashboard.evolution.details.noDiff') : (proposal.diff ?? []).map((item, index) => (
                        <div key={`${item.path}-${index}`} className="border-b border-[#e9edf3] py-1 last:border-0">
                          <span className="mr-2 text-[#12805c]">
                            <RawIdentifier value={item.op || 'change'} />
                          </span>
                          <span>{item.path ? <RawIdentifier value={item.path} /> : <RawIdentifier value="/" />}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </details>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** 为风险标签返回当前设计系统约定的视觉样式。 */
function riskClass(risk: string): string {
  if (risk === 'high') return 'bg-[#ffe8e8] text-[#c13d3d]';
  if (risk === 'medium') return 'bg-[#fff4da] text-[#9a6a08]';
  return 'bg-[#e8f8f0] text-[#168760]';
}

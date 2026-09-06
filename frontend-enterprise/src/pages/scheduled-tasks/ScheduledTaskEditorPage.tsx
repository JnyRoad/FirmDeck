import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { createToastNotifier } from '@/components/ui/app-toast';
import { getClientTimeZone } from '@/lib/timezone';

import AppHeader from '@/components/AppHeader';
import { Button } from '@/components/ui/button';
import {
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@/components/ui';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { type MessageId } from '@/i18n/types';
import { cn } from '@/lib/utils';
import { useAppIntl } from '@/i18n';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';

import { createTenantClient } from '../../api/tenant-client';
import IconArrowRight from '../../assets/icons/arrow-right.svg?react';
import IconAlarm from '../../assets/icons/profile-alarm.svg?react';
import type { EnterpriseAuthUser } from '../../auth';
import { useTenantSession } from '../../contexts/TenantSessionContext';
import { isTeamScope, persistSharedAgentScope, readEmployeeScope } from '../../lib/agent-scope-storage';
import type { ScheduledTaskRead, SkillRead } from '../../types';
import {
  INITIAL_VALUES,
  buildSchedule,
  scheduledTaskSopOptions,
  taskToFormValues,
  weekdayOptions,
  type TaskFormValues,
} from './shared';

export type ScheduledTaskPageProps = {
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
};

/** 渲染新建模式的定时任务编辑器，并透传当前用户和退出回调。 */
export function ScheduledTaskNewPage(props: ScheduledTaskPageProps = {}) {
  return <ScheduledTaskEditorPage mode="new" {...props} />;
}

/** 渲染编辑模式的定时任务编辑器，并透传当前用户和退出回调。 */
export function ScheduledTaskEditPage(props: ScheduledTaskPageProps = {}) {
  return <ScheduledTaskEditorPage mode="edit" {...props} />;
}

type FormErrors = Partial<Record<'title' | 'prompt' | 'run_at' | 'time' | 'weekdays', string>>;

const CARD_CLASS =
  'rounded-[14px] border border-[#eceef1] bg-white p-[20px]';
const CARD_TITLE_CLASS = 'mb-[16px] text-[14px] font-medium text-[#18181a]';
const FIELD_LABEL_CLASS = 'text-[13px] font-medium text-[#18181a]';
const FIELD_ERROR_CLASS = 'text-[12px] leading-none text-[#d20b0b]';

/** 将稳定后端错误投影为编辑器可展示的 descriptor，未知/畸形异常使用安全 fallback。 */
function editorErrorDescriptor(error: unknown, fallbackId: MessageId): MessageDescriptor {
  const descriptor = backendErrorMessageDescriptor(error);
  return descriptor
    ? { id: descriptor.messageId, values: descriptor.values }
    : createMessageDescriptor(fallbackId);
}

/** 加载并保存定时任务编辑表单，同时将产品界面文案交给当前 locale 的 runtime。 */
export default function ScheduledTaskEditorPage({
  mode,
  currentUser,
  onLogout,
}: { mode: 'new' | 'edit' } & ScheduledTaskPageProps) {
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const tenantId = tenantContext?.tenantId || '';
  const userId = tenantContext?.userId || '';
  const tenantScopeKey = tenantContext
    ? `${tenantId}:${userId}:${tenantContext.generation}`
    : '';
  const scopeKeyRef = useRef('');
  const establishedScopeRef = useRef(false);
  const [scopeReady, setScopeReady] = useState(false);
  const [values, setValues] = useState<TaskFormValues>(INITIAL_VALUES);
  const [errors, setErrors] = useState<FormErrors>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [sops, setSops] = useState<SkillRead[]>([]);
  const [taskMetadata, setTaskMetadata] = useState<Record<string, unknown>>({});
  const navigate = useNavigate();
  const { taskId } = useParams();
  const { locale, t: translate } = useAppIntl();
  const toast = useMemo(() => createToastNotifier({ t: translate }), [translate]);
  const isEdit = mode === 'edit';
  const routeIdentity = `${isEdit ? 'edit' : 'new'}:${taskId || ''}`;
  const agentIdRef = useRef('');
  const scopeRevisionRef = useRef(0);
  const actionControllersRef = useRef(new Set<AbortController>());
  const taskIdRef = useRef(taskId || '');
  const routeIdentityRef = useRef(routeIdentity);
  const lastRouteIdentityRef = useRef(routeIdentity);
  const routeRevisionRef = useRef(0);
  const scheduleType = values.schedule_type;
  const localizedWeekdayOptions = weekdayOptions({ locale, t: translate });
  const pinnedSopVersion =
    typeof taskMetadata.sop_version === 'string' && taskMetadata.sop_version
      ? taskMetadata.sop_version
      : undefined;
  const tenantScopeTransition = establishedScopeRef.current && scopeKeyRef.current !== tenantScopeKey;

  // Keep route and employee identity current before passive effects run so late callbacks
  // cannot publish into a newly mounted task editor.
  agentIdRef.current = agentId;
  taskIdRef.current = taskId || '';
  routeIdentityRef.current = routeIdentity;

  /** Abort editor actions when tenant/employee scope or the task route changes. */
  function cancelActionControllers() {
    actionControllersRef.current.forEach((controller) => controller.abort());
    actionControllersRef.current.clear();
  }

  /** Advance the employee scope revision synchronously and clear stale request busy state. */
  function updateAgentScope(nextAgentId: string) {
    agentIdRef.current = nextAgentId;
    scopeRevisionRef.current += 1;
    cancelActionControllers();
    setAgentId(nextAgentId);
    setLoading(false);
    setSaving(false);
  }

  useEffect(() => {
    if (lastRouteIdentityRef.current === routeIdentity) return;
    lastRouteIdentityRef.current = routeIdentity;
    routeRevisionRef.current += 1;
    cancelActionControllers();
    setSaving(false);
    setLoading(false);
  }, [routeIdentity]);

  useEffect(() => () => cancelActionControllers(), [tenantContext?.generation]);

  /** 更新表单字段；调用方负责提供与字段键匹配的值。 */
  function update<K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  useEffect(() => {
    if (!tenantContext || !tenantId || !userId) {
      scopeKeyRef.current = '';
      establishedScopeRef.current = false;
      agentIdRef.current = '';
      scopeRevisionRef.current += 1;
      cancelActionControllers();
      setScopeReady(false);
      setAgentId('');
      setValues(INITIAL_VALUES);
      setErrors({});
      setSops([]);
      setTaskMetadata({});
      setLoading(false);
      setSaving(false);
      return;
    }
    const scopeChanged = scopeKeyRef.current !== tenantScopeKey;
    scopeKeyRef.current = tenantScopeKey;
    establishedScopeRef.current = true;
    const nextAgentId = readEmployeeScope(tenantId, userId);
    agentIdRef.current = nextAgentId;
    scopeRevisionRef.current += 1;
    cancelActionControllers();
    setAgentId(nextAgentId);
    setScopeReady(true);
    if (scopeChanged) {
      setValues(INITIAL_VALUES);
      setErrors({});
      setSops([]);
      setTaskMetadata({});
      setLoading(false);
      setSaving(false);
    }
  }, [tenantContext, tenantId, tenantScopeKey, userId]);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const next = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      if (!tenantContext || !tenantId || !userId || scopeKeyRef.current !== tenantScopeKey) return;
      updateAgentScope(next && !isTeamScope(next) ? next : readEmployeeScope(tenantId, userId));
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, [tenantContext, tenantId, tenantScopeKey, userId]);

  useEffect(() => {
    if (tenantScopeTransition || !tenantContext || !tenantId || !userId || !scopeReady || scopeKeyRef.current !== tenantScopeKey) return;
    if (!isEdit) {
      setValues(INITIAL_VALUES);
      return;
    }
    if (!taskId) return;
    const requestController = new AbortController();
    const generation = tenantContext.generation;
    const capturedAgentId = agentId;
    const capturedScopeRevision = scopeRevisionRef.current;
    const capturedTaskId = taskId || '';
    const capturedRouteIdentity = routeIdentity;
    const capturedRouteRevision = routeRevisionRef.current;
    const isCurrent = () => (
      !requestController.signal.aborted
      && tenantContext.isCurrentGeneration(generation)
      && scopeKeyRef.current === tenantScopeKey
      && agentIdRef.current === capturedAgentId
      && scopeRevisionRef.current === capturedScopeRevision
      && taskIdRef.current === capturedTaskId
      && routeIdentityRef.current === capturedRouteIdentity
      && routeRevisionRef.current === capturedRouteRevision
    );
    setLoading(true);
    tenantClient
      .get<ScheduledTaskRead>(`/api/enterprise/scheduled-tasks/${taskId}`, { signal: requestController.signal })
      .then((row) => {
        if (!isCurrent()) return;
        if (row.tenant_id && row.tenant_id !== tenantId) return;
        if (row.agent_id !== agentIdRef.current) updateAgentScope(row.agent_id);
        else setAgentId(row.agent_id);
        persistSharedAgentScope(row.agent_id, tenantId, userId);
        setTaskMetadata(row.metadata || {});
        setValues(taskToFormValues(row));
      })
      .catch((error) => {
        if (isCurrent()) toast.error(editorErrorDescriptor(error, 'scheduledTasksPage.editor.toast.loadFailed'));
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    return () => requestController.abort();
  }, [isEdit, scopeReady, taskId, tenantClient, tenantContext, tenantId, tenantScopeKey, tenantScopeTransition, toast, userId]);

  useEffect(() => {
    if (tenantScopeTransition || !tenantContext || !tenantId || !userId || !scopeReady || scopeKeyRef.current !== tenantScopeKey) return;
    if (!agentId) {
      setSops([]);
      return;
    }
    const requestController = new AbortController();
    const generation = tenantContext.generation;
    const capturedAgentId = agentId;
    const capturedScopeRevision = scopeRevisionRef.current;
    const isCurrent = () => (
      !requestController.signal.aborted
      && tenantContext.isCurrentGeneration(generation)
      && scopeKeyRef.current === tenantScopeKey
      && agentIdRef.current === capturedAgentId
      && scopeRevisionRef.current === capturedScopeRevision
    );
    tenantClient
      .get<SkillRead[]>(
        `/api/enterprise/skills?agent_id=${encodeURIComponent(agentId)}`,
        { signal: requestController.signal },
      )
      .then((rows) => {
        if (!isCurrent()) return;
        setSops(scheduledTaskSopOptions(rows));
      })
      .catch(() => {
        if (isCurrent()) setSops([]);
      });
    return () => {
      requestController.abort();
    };
  }, [agentId, scopeReady, tenantClient, tenantContext, tenantId, tenantScopeKey, tenantScopeTransition, userId]);

  /** 校验必填排程字段并返回表单是否可提交，副作用是更新字段错误状态。 */
  function validate(): boolean {
    const nextErrors: FormErrors = {};
    if (!values.title.trim()) {
      nextErrors.title = translate('scheduledTasksPage.editor.validation.titleRequired');
    }
    if (!values.prompt.trim()) {
      nextErrors.prompt = translate('scheduledTasksPage.editor.validation.promptRequired');
    }
    if (values.schedule_type === 'once') {
      if (!values.run_at) {
        nextErrors.run_at = translate('scheduledTasksPage.editor.validation.runAtRequired');
      }
    } else if (!values.time) {
      nextErrors.time = translate('scheduledTasksPage.editor.validation.timeRequired');
    }
    if (values.schedule_type === 'weekly' && !values.weekdays.length) {
      nextErrors.weekdays = translate('scheduledTasksPage.editor.validation.weekdaysRequired');
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  /** 将已校验表单提交到后端，失败时只通过稳定错误 descriptor 呈现公共信息。 */
  async function save() {
    if (!tenantContext || !tenantId || !userId || !scopeReady || scopeKeyRef.current !== tenantScopeKey) return;
    if (!validate()) return;
    if (!agentId) {
      toast.error(createMessageDescriptor('scheduledTasksPage.editor.validation.agentRequired'));
      return;
    }
    const metadata: Record<string, unknown> = {
      ...taskMetadata,
      ...(values.sop_id
        ? {
            sop_id: values.sop_id,
            sop_version_policy: values.sop_version_policy,
          }
        : {}),
    };
    if (!values.sop_id) {
      delete metadata.sop_id;
      delete metadata.sop_version_policy;
      delete metadata.sop_version;
    }
    const payload = {
      agent_id: agentId,
      title: values.title.trim(),
      prompt: values.prompt.trim(),
      description: values.description?.trim() || undefined,
      schedule_type: values.schedule_type,
      schedule: buildSchedule(values),
      timezone: getClientTimeZone(),
      status: values.status,
      concurrency_policy: 'forbid',
      misfire_policy: 'coalesce',
      max_runs: values.max_runs || undefined,
      metadata,
    };
    const requestController = new AbortController();
    actionControllersRef.current.add(requestController);
    const generation = tenantContext.generation;
    const capturedAgentId = agentId;
    const capturedScopeRevision = scopeRevisionRef.current;
    const capturedTaskId = taskId || '';
    const capturedRouteIdentity = routeIdentity;
    const capturedRouteRevision = routeRevisionRef.current;
    const isCurrent = () => (
      !requestController.signal.aborted
      && tenantContext.isCurrentGeneration(generation)
      && scopeKeyRef.current === tenantScopeKey
      && agentIdRef.current === capturedAgentId
      && scopeRevisionRef.current === capturedScopeRevision
      && taskIdRef.current === capturedTaskId
      && routeIdentityRef.current === capturedRouteIdentity
      && routeRevisionRef.current === capturedRouteRevision
    );
    setSaving(true);
    try {
      const saved =
        isEdit && taskId
          ? await tenantClient.put<ScheduledTaskRead>(`/api/enterprise/scheduled-tasks/${taskId}`, payload, {
            signal: requestController.signal,
          })
          : await tenantClient.post<ScheduledTaskRead>('/api/enterprise/scheduled-tasks', payload, {
            signal: requestController.signal,
          });
      if (!isCurrent()) return;
      toast.success(createMessageDescriptor('scheduledTasksPage.editor.toast.saved'));
      if (!isEdit) {
        navigate(`/enterprise/scheduled-tasks/${saved.id}/edit`, { replace: true });
      } else {
        setTaskMetadata(saved.metadata || {});
        setValues(taskToFormValues(saved));
      }
    } catch (error) {
      if (isCurrent()) toast.error(editorErrorDescriptor(error, 'scheduledTasksPage.editor.toast.saveFailed'));
    } finally {
      if (isCurrent()) setSaving(false);
      actionControllersRef.current.delete(requestController);
    }
  }

  /** 切换周计划中的星期并按协议数值顺序保存选择结果。 */
  function toggleWeekday(day: number, checked: boolean) {
    setValues((prev) => {
      const next = checked
        ? [...prev.weekdays, day]
        : prev.weekdays.filter((item) => item !== day);
      return { ...prev, weekdays: next.sort((a, b) => a - b) };
    });
  }

  if (tenantScopeTransition) {
    return <div className="min-h-full" aria-busy="true" />;
  }

  return (
    <div
      className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]"
      aria-busy={loading || saving}
    >
      <AppHeader
        onLogout={onLogout}
        userName={currentUser?.username}
        title={translate(isEdit ? 'scheduledTasksPage.editor.editTitle' : 'scheduledTasksPage.editor.newTitle')}
        description={translate('scheduledTasksPage.editor.description')}
      />
      <div className="flex justify-end gap-[16px] mt-[20px] mb-[16px]">
        <Button
          variant="outline"
          onClick={() => navigate('/enterprise/scheduled-tasks')}
          className="h-8 gap-1 rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-5 text-[12px] font-normal text-[#757f9c] hover:border-[#cbd3e6] hover:bg-white hover:text-primary"
        >
          <IconArrowRight className="size-3.5 rotate-180" />
          {translate('scheduledTasksPage.editor.action.back')}
        </Button>
        <Button
          onClick={() => void save()}
          disabled={saving}
          className="h-8 gap-1 rounded-[10px] bg-primary px-5 text-[12px] font-normal text-white hover:bg-primary/80"
        >
          {translate('scheduledTasksPage.editor.action.save')}
        </Button>
      </div>

      <div className="grid grid-cols-1 items-start gap-[20px] lg:grid-cols-2">
        <section className={CARD_CLASS}>
          <h3 className={CARD_TITLE_CLASS}>
            {translate('scheduledTasksPage.editor.section.details')}
          </h3>
          <div className="flex flex-col gap-[16px]">
            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="task-title" className={FIELD_LABEL_CLASS}>
                {translate('scheduledTasksPage.editor.field.title')}
              </Label>
              <div className="relative">
                <IconAlarm className="pointer-events-none absolute left-[10px] top-1/2 size-[14px] -translate-y-1/2 text-[#858b9c]" />
                <Input
                  id="task-title"
                  className={cn('pl-[30px]', errors.title && 'border-destructive')}
                  maxLength={80}
                  placeholder={translate('scheduledTasksPage.editor.placeholder.title')}
                  value={values.title}
                  onChange={(event) => update('title', event.target.value)}
                />
              </div>
              {errors.title && <p className={FIELD_ERROR_CLASS}>{errors.title}</p>}
            </div>

            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="task-prompt" className={FIELD_LABEL_CLASS}>
                {translate('scheduledTasksPage.editor.field.prompt')}
              </Label>
              <Textarea
                id="task-prompt"
                rows={7}
                maxLength={10000}
                className={cn(errors.prompt && 'border-destructive')}
                placeholder={translate('scheduledTasksPage.editor.placeholder.prompt')}
                value={values.prompt}
                onChange={(event) => update('prompt', event.target.value)}
              />
              <div className="flex items-center justify-between">
                {errors.prompt ? (
                  <p className={FIELD_ERROR_CLASS}>{errors.prompt}</p>
                ) : (
                  <span />
                )}
                <span className="text-[12px] leading-none text-[#858b9c]">
                  {values.prompt.length}/10000
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-[6px]">
              <Label className={FIELD_LABEL_CLASS}>
                {translate('scheduledTasksPage.editor.field.sop')}
              </Label>
              <Select
                value={values.sop_id || '__auto__'}
                onValueChange={(value) => {
                  const sopId = value === '__auto__' ? '' : value;
                  setValues((prev) => ({
                    ...prev,
                    sop_id: sopId,
                    sop_version_policy: sopId ? prev.sop_version_policy : 'latest',
                  }));
                }}
              >
                <SelectTrigger className="w-full" aria-label={translate('scheduledTasksPage.editor.field.sop')}>
                  <SelectValue placeholder={translate('scheduledTasksPage.editor.placeholder.sop')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__auto__">
                    {translate('scheduledTasksPage.editor.sop.auto')}
                  </SelectItem>
                  {sops.map((sop) => (
                    <SelectItem key={sop.skill_id} value={sop.skill_id}>
                      <RawContent value={sop.name} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[12px] leading-[18px] text-[#858b9c]">
                {translate('scheduledTasksPage.editor.sop.help')}
              </p>
            </div>

            {values.sop_id && (
              <div className="flex flex-col gap-[6px]">
                <Label className={FIELD_LABEL_CLASS}>
                  {translate('scheduledTasksPage.editor.field.sopVersionPolicy')}
                </Label>
                <Select
                  value={values.sop_version_policy}
                  onValueChange={(value) =>
                    update('sop_version_policy', value === 'pinned' ? 'pinned' : 'latest')
                  }
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={translate('scheduledTasksPage.editor.field.sopVersionPolicy')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="latest">
                      {translate('scheduledTasksPage.editor.sopVersionPolicy.latest')}
                    </SelectItem>
                    <SelectItem value="pinned">
                      {translate('scheduledTasksPage.editor.sopVersionPolicy.pinned')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[12px] leading-[18px] text-[#858b9c]">
                  {values.sop_version_policy === 'latest'
                    ? translate('scheduledTasksPage.editor.sopVersionPolicy.latestHelp')
                    : (
                      <>
                        {translate('scheduledTasksPage.editor.sopVersionPolicy.pinnedHelp')}
                        {pinnedSopVersion && (
                          <>
                            {' '}
                            {translate('scheduledTasksPage.editor.sopVersionPolicy.pinnedVersionPrefix')}
                            <RawIdentifier value={pinnedSopVersion} />
                          </>
                        )}
                      </>
                    )}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="task-description" className={FIELD_LABEL_CLASS}>
                {translate('scheduledTasksPage.editor.field.internalNote')}
              </Label>
              <Textarea
                id="task-description"
                rows={3}
                placeholder={translate('scheduledTasksPage.editor.placeholder.internalNote')}
                value={values.description || ''}
                onChange={(event) => update('description', event.target.value)}
              />
            </div>
          </div>
        </section>

        <section className={CARD_CLASS}>
          <h3 className={CARD_TITLE_CLASS}>
            {translate('scheduledTasksPage.editor.section.schedule')}
          </h3>
          <div className="flex flex-col gap-[16px]">
            <div className="flex items-center justify-between">
              <Label htmlFor="task-status" className={FIELD_LABEL_CLASS}>
                {translate('scheduledTasksPage.editor.field.status')}
              </Label>
              <div className="flex items-center gap-[8px]">
                <Switch
                  id="task-status"
                  checked={values.status !== 'paused'}
                  onCheckedChange={(checked) => update('status', checked ? 'active' : 'paused')}
                />
                <span className="text-[13px] text-[#858b9c]">
                  {values.status !== 'paused'
                    ? translate('scheduledTasksPage.editor.status.active')
                    : translate('scheduledTasksPage.editor.status.paused')}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-[6px]">
              <Label className={FIELD_LABEL_CLASS}>
                {translate('scheduledTasksPage.editor.field.scheduleType')}
              </Label>
              <Select
                value={values.schedule_type}
                onValueChange={(value) =>
                  update('schedule_type', value as TaskFormValues['schedule_type'])
                }
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={translate('scheduledTasksPage.editor.field.scheduleType')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">
                    {translate('scheduledTasksPage.editor.scheduleType.daily')}
                  </SelectItem>
                  <SelectItem value="weekly">
                    {translate('scheduledTasksPage.editor.scheduleType.weekly')}
                  </SelectItem>
                  <SelectItem value="monthly">
                    {translate('scheduledTasksPage.editor.scheduleType.monthly')}
                  </SelectItem>
                  <SelectItem value="once">
                    {translate('scheduledTasksPage.editor.scheduleType.once')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {scheduleType === 'once' ? (
              <div className="flex flex-col gap-[6px]">
                <Label htmlFor="task-run-at" className={FIELD_LABEL_CLASS}>
                  {translate('scheduledTasksPage.editor.field.executionTime')}
                </Label>
                <Input
                  id="task-run-at"
                  type="datetime-local"
                  className={cn(errors.run_at && 'border-destructive')}
                  value={values.run_at}
                  onChange={(event) => update('run_at', event.target.value)}
                />
                {errors.run_at && <p className={FIELD_ERROR_CLASS}>{errors.run_at}</p>}
              </div>
            ) : (
              <div className="flex flex-col gap-[6px]">
                <Label htmlFor="task-time" className={FIELD_LABEL_CLASS}>
                  {translate('scheduledTasksPage.editor.field.executionTime')}
                </Label>
                <Input
                  id="task-time"
                  type="time"
                  className={cn(errors.time && 'border-destructive')}
                  value={values.time}
                  onChange={(event) => update('time', event.target.value)}
                />
                {errors.time && <p className={FIELD_ERROR_CLASS}>{errors.time}</p>}
              </div>
            )}

            {scheduleType === 'weekly' && (
              <div className="flex flex-col gap-[8px]">
                <Label className={FIELD_LABEL_CLASS}>
                  {translate('scheduledTasksPage.editor.field.executionDate')}
                </Label>
                <div className="flex flex-wrap gap-x-[16px] gap-y-[10px]">
                  {localizedWeekdayOptions.map((option) => (
                    <label
                      key={option.value}
                      className="flex cursor-pointer items-center gap-[6px] text-[13px] text-[#18181a]"
                    >
                      <Checkbox
                        checked={values.weekdays.includes(option.value)}
                        onCheckedChange={(checked) =>
                          toggleWeekday(option.value, checked === true)
                        }
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
                {errors.weekdays && <p className={FIELD_ERROR_CLASS}>{errors.weekdays}</p>}
              </div>
            )}

            {scheduleType === 'monthly' && (
              <div className="flex flex-col gap-[6px]">
                <Label htmlFor="task-day" className={FIELD_LABEL_CLASS}>
                  {translate('scheduledTasksPage.editor.field.dayOfMonth')}
                </Label>
                <Input
                  id="task-day"
                  type="number"
                  min={1}
                  max={31}
                  className="w-[120px]"
                  value={values.day_of_month}
                  onChange={(event) => update('day_of_month', Number(event.target.value) || 1)}
                />
              </div>
            )}

            <div className="flex flex-col gap-[6px]">
              <Label htmlFor="task-max-runs" className={FIELD_LABEL_CLASS}>
                {translate('scheduledTasksPage.editor.field.maxRuns')}
              </Label>
              <Input
                id="task-max-runs"
                type="number"
                min={1}
                placeholder={translate('scheduledTasksPage.editor.placeholder.maxRuns')}
                value={values.max_runs ?? ''}
                onChange={(event) =>
                  update('max_runs', event.target.value ? Number(event.target.value) : undefined)
                }
              />
            </div>

            <div className="rounded-[12px] border border-[#eef0f4] bg-[#fafbfc] px-[14px] py-[12px] text-[13px] leading-[1.6] text-[#858b9c]">
              {translate('scheduledTasksPage.editor.notice.concurrency')}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';

import FirmdeckIcon from '@/components/FirmdeckIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createToastNotifier } from '@/components/ui/app-toast';
import { createMessageDescriptor } from '@/i18n/descriptors';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import { getClientTimeZone } from '@/lib/timezone';
import { cn } from '@/lib/utils';
import type { ScheduledTaskDraftRead, ScheduledTaskRead } from '@/types';

import {
  CHAT_DRAFT_CARD_CLASS,
  CHAT_DRAFT_CARD_CREATED_CLASS,
  CHAT_DRAFT_CREATED_BADGE_CLASS,
  CHAT_DRAFT_EDITOR_CLASS,
  CHAT_DRAFT_EDITOR_FULL_CLASS,
  CHAT_DRAFT_FOOTER_CLASS,
  CHAT_DRAFT_HEADER_CLASS,
  CHAT_DRAFT_ICON_CLASS,
  CHAT_DRAFT_IDENTITY_CLASS,
  CHAT_DRAFT_KICKER_CLASS,
  CHAT_DRAFT_META_GRID_CLASS,
  CHAT_DRAFT_META_ITEM_CLASS,
  CHAT_DRAFT_PROMPT_CLASS,
  CHAT_DRAFT_TITLE_CLASS,
  CHAT_DRAFT_TOP_ACTIONS_CLASS,
} from '../chatPageStyles';
import {
  draftScheduleForType,
  formatDraftSchedule,
  normalizeDraftScheduleType,
  scheduleEditValue,
  scheduleFromEditValue,
  scheduleTypeLabel,
} from '../chatHelpers';

type ScheduledDraftCardProps = {
  draft: ScheduledTaskDraftRead;
  createdTask?: ScheduledTaskRead;
  onConfirm: (draft: ScheduledTaskDraftRead) => void;
  onDismiss: () => void;
};

/** 展示并编辑聊天生成的定时任务草案，保留业务字段 raw 值并本地化产品 chrome。 */
export default function ScheduledDraftCard({
  draft,
  createdTask,
  onConfirm,
  onDismiss,
}: ScheduledDraftCardProps) {
  const { locale, t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const [editing, setEditing] = useState(false);
  const [editableDraft, setEditableDraft] = useState<ScheduledTaskDraftRead>(draft);
  const created = Boolean(createdTask);
  const currentTimezone = getClientTimeZone();
  const displayDraft = createdTask
    ? ({
      ...draft,
      title: createdTask.title,
      prompt: createdTask.prompt,
      description: createdTask.description || draft.description,
      schedule_type: createdTask.schedule_type,
      schedule: createdTask.schedule,
      timezone: createdTask.timezone,
      rrule: createdTask.rrule || draft.rrule,
    } as ScheduledTaskDraftRead)
    : editableDraft;

  useEffect(() => {
    setEditableDraft(draft);
    setEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draft.agent_id,
    draft.title,
    draft.prompt,
    draft.description,
    draft.schedule_type,
    draft.timezone,
    draft.rrule,
    JSON.stringify(draft.schedule || {}),
    createdTask?.id,
  ]);

  /** 更新草案字段；用户输入的标题、说明和执行内容保持原始值。 */
  const updateDraft = (patch: Partial<ScheduledTaskDraftRead>) => {
    setEditableDraft((current) => ({ ...current, ...patch }));
  };
  const scheduleValue = scheduleEditValue(editableDraft);
  /** 校验创建前的必填字段，并通过稳定消息 ID 呈现产品错误。 */
  const validateDraft = (nextDraft: ScheduledTaskDraftRead) => {
    if (!nextDraft.title.trim()) {
      toast.warning(createMessageDescriptor('chat.draft.titleRequired'));
      return false;
    }
    if (!nextDraft.prompt.trim()) {
      toast.warning(createMessageDescriptor('chat.draft.contentRequired'));
      return false;
    }
    if (!scheduleEditValue(nextDraft).trim()) {
      toast.warning(createMessageDescriptor('chat.draft.scheduleRequired'));
      return false;
    }
    return true;
  };
  /** 切换排程类型并保留可复用的结构化排程字段。 */
  const updateScheduleType = (value: ScheduledTaskDraftRead['schedule_type']) => {
    setEditableDraft((current) => {
      const scheduleType = normalizeDraftScheduleType(value);
      const schedule = draftScheduleForType(current.schedule || {}, scheduleType);
      return { ...current, schedule_type: scheduleType, schedule };
    });
  };
  /** 更新一次性时间或重复任务时间输入，不改写用户输入的 wire 值。 */
  const updateScheduleValue = (value: string) => {
    setEditableDraft((current) => ({ ...current, schedule: scheduleFromEditValue(current, value) }));
  };
  /** 完成编辑前重新校验草案，但不触发创建请求。 */
  const completeEdit = () => {
    if (!validateDraft(editableDraft)) return;
    setEditing(false);
  };
  /** 确认未创建草案并交给父级执行创建流程。 */
  const confirmDraft = () => {
    if (created) return;
    if (!validateDraft(editableDraft)) return;
    onConfirm(editableDraft);
  };

  return (
    <div className={cn(CHAT_DRAFT_CARD_CLASS, created && CHAT_DRAFT_CARD_CREATED_CLASS)}>
      <div className={CHAT_DRAFT_HEADER_CLASS}>
        <div className={CHAT_DRAFT_IDENTITY_CLASS}>
          <div className={CHAT_DRAFT_ICON_CLASS}>
            <FirmdeckIcon name={created ? 'check' : 'clock'} size={18} />
          </div>
          <div className="grid min-w-0 gap-[2px]">
            <div className={CHAT_DRAFT_KICKER_CLASS}>
              {created ? t('chat.draft.created') : t('chat.draft.preview')}
            </div>
            {editing ? (
              <Input
                className="h-[30px]"
                value={editableDraft.title}
                onChange={(event) => updateDraft({ title: event.target.value })}
              />
            ) : (
              <strong className={CHAT_DRAFT_TITLE_CLASS}>
                <RawContent value={displayDraft.title} />
              </strong>
            )}
          </div>
        </div>
        <div className={CHAT_DRAFT_TOP_ACTIONS_CLASS}>
          {created ? (
            <span className={CHAT_DRAFT_CREATED_BADGE_CLASS}>
              <FirmdeckIcon name="check" size={13} />
              {t('chat.draft.createdBadge')}
            </span>
          ) : editing ? (
            <>
              <Button size="sm" onClick={completeEdit}>{t('chat.draft.complete')}</Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditableDraft(draft);
                  setEditing(false);
                }}
              >
                {t('chat.draft.cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                <FirmdeckIcon name="edit" size={14} />
                {t('chat.draft.edit')}
              </Button>
              <Button size="sm" variant="ghost" onClick={onDismiss}>{t('chat.draft.dismiss')}</Button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <div className={CHAT_DRAFT_EDITOR_CLASS}>
          <label>
            <span>{t('chat.draft.scheduleType')}</span>
            <Select value={editableDraft.schedule_type} onValueChange={updateScheduleType}>
              <SelectTrigger className="h-[32px] w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="once">{t('chat.draft.once')}</SelectItem>
                <SelectItem value="daily">{t('chat.draft.daily')}</SelectItem>
                <SelectItem value="weekly">{t('chat.draft.weekly')}</SelectItem>
                <SelectItem value="monthly">{t('chat.draft.monthly')}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label>
            <span>{t('chat.draft.schedule')}</span>
            <Input
              className="h-[32px]"
              value={scheduleValue}
              placeholder={editableDraft.schedule_type === 'once'
                ? t('chat.draft.onceSchedulePlaceholder', { timeZone: currentTimezone })
                : t('chat.draft.timePlaceholder')}
              onChange={(event) => updateScheduleValue(event.target.value)}
            />
          </label>
          <label>
            <span>{t('chat.draft.timezone')}</span>
            <Input
              className="h-[32px]"
              value={editableDraft.timezone || currentTimezone}
              onChange={(event) => updateDraft({ timezone: event.target.value })}
            />
          </label>
          <label className={CHAT_DRAFT_EDITOR_FULL_CLASS}>
            <span>{t('chat.draft.content')}</span>
            <Textarea
              rows={3}
              value={editableDraft.prompt}
              onChange={(event) => updateDraft({ prompt: event.target.value })}
            />
          </label>
          <label className={CHAT_DRAFT_EDITOR_FULL_CLASS}>
            <span>{t('chat.draft.description')}</span>
            <Textarea
              rows={2}
              value={editableDraft.description || ''}
              placeholder={t('chat.draft.descriptionPlaceholder')}
              onChange={(event) => updateDraft({ description: event.target.value })}
            />
          </label>
        </div>
      ) : (
        <div className="grid gap-[12px]">
          <div className={CHAT_DRAFT_META_GRID_CLASS}>
            <div className={CHAT_DRAFT_META_ITEM_CLASS}>
              <span>{t('chat.draft.schedule')}</span>
              <strong>{formatDraftSchedule(displayDraft, locale, t, currentTimezone)}</strong>
            </div>
            <div className={CHAT_DRAFT_META_ITEM_CLASS}>
              <span>{t('chat.draft.type')}</span>
              <strong>{scheduleTypeLabel(displayDraft.schedule_type, t)}</strong>
            </div>
            <div className={CHAT_DRAFT_META_ITEM_CLASS}>
              <span>{t('chat.draft.timezone')}</span>
              <strong><RawIdentifier value={displayDraft.timezone || currentTimezone} /></strong>
            </div>
          </div>
          <div className={CHAT_DRAFT_PROMPT_CLASS}>
            <span>{t('chat.draft.content')}</span>
            <p><RawContent value={displayDraft.prompt} /></p>
          </div>
          {displayDraft.description && (
            <div className={CHAT_DRAFT_PROMPT_CLASS}>
              <span>{t('chat.draft.description')}</span>
              <p><RawContent value={displayDraft.description} /></p>
            </div>
          )}
        </div>
      )}
      {!created && (
        <div className={CHAT_DRAFT_FOOTER_CLASS}>
          {editing && (
            <Button size="sm" variant="ghost" onClick={onDismiss}>{t('chat.draft.dismiss')}</Button>
          )}
          <Button size="sm" onClick={confirmDraft}>{t('chat.draft.confirmCreate')}</Button>
        </div>
      )}
    </div>
  );
}

import { IdcardOutlined } from '../icons';
import { X as XIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  Button as UIButton,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@/components/ui';
import { createToastNotifier } from '@/components/ui/app-toast';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { MessageId } from '@/i18n/types';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';
import { SELECT_TRIGGER_CLASS } from '@/lib/enterprise-ui';
import { api, TENANT_ID } from '../api/client';
import type { EnterpriseAuthUser } from '../auth';
import { employeeDisplayName, employeeProfile } from '../employee';
import type { AgentProfileRead } from '../types';
import EmployeeAvatar from './EmployeeAvatar';

type EmployeeProfileFormValues = {
  name: string;
  roleName: string;
  onboardedAt: string;
  description: string;
  personaPrompt: string;
  systemPromptSummary: string;
  workStyles: string[];
  expertiseTags: string[];
  workModes: string[];
  harnessMaxActions: number;
  status: 'active' | 'archived';
  publishedToGallery: boolean;
};

const STYLE_OPTIONS = ['目标明确', '证据优先', '动作可追溯', '事实先行', '流程推进', '风险克制', '及时追问'];
const EXPERTISE_OPTIONS = ['业务问答', 'SOP 执行', '工具调用', '代码检索', '报销核对', '事务跟进', '资料维护'];
const WORK_MODE_OPTIONS = ['识别意图', '补齐信息', '调用 SOP', '查询资料', '执行并复盘', '确认后执行', '必要时转人工'];

const STYLE_MESSAGE_IDS: Record<string, MessageId> = {
  '目标明确': 'employeeProfile.option.style.goalFocused',
  '证据优先': 'employeeProfile.option.style.evidenceFirst',
  '动作可追溯': 'employeeProfile.option.style.traceableActions',
  '事实先行': 'employeeProfile.option.style.factsFirst',
  '流程推进': 'employeeProfile.option.style.processDriven',
  '风险克制': 'employeeProfile.option.style.riskAware',
  '及时追问': 'employeeProfile.option.style.clarifyEarly',
};

const EXPERTISE_MESSAGE_IDS: Record<string, MessageId> = {
  '业务问答': 'employeeProfile.option.expertise.businessQa',
  'SOP 执行': 'employeeProfile.option.expertise.sopExecution',
  '工具调用': 'employeeProfile.option.expertise.toolUse',
  '代码检索': 'employeeProfile.option.expertise.codeRetrieval',
  '报销核对': 'employeeProfile.option.expertise.expenseReview',
  '事务跟进': 'employeeProfile.option.expertise.followUp',
  '资料维护': 'employeeProfile.option.expertise.contentMaintenance',
};

const WORK_MODE_MESSAGE_IDS: Record<string, MessageId> = {
  '识别意图': 'employeeProfile.option.mode.intentRecognition',
  '补齐信息': 'employeeProfile.option.mode.fillGaps',
  '调用 SOP': 'employeeProfile.option.mode.sopExecution',
  '查询资料': 'employeeProfile.option.mode.research',
  '执行并复盘': 'employeeProfile.option.mode.executeReview',
  '确认后执行': 'employeeProfile.option.mode.confirmThenAct',
  '必要时转人工': 'employeeProfile.option.mode.escalate',
};

const BLANK_FORM: EmployeeProfileFormValues = {
  name: '',
  roleName: '',
  onboardedAt: '',
  description: '',
  personaPrompt: '',
  systemPromptSummary: '',
  workStyles: [],
  expertiseTags: [],
  workModes: [],
  harnessMaxActions: 32,
  status: 'active',
  publishedToGallery: false,
};

export default function EmployeeProfileEditor({
  agent,
  open,
  onClose,
  onSaved,
  currentUser,
}: {
  agent?: AgentProfileRead | null;
  open: boolean;
  onClose: () => void;
  onSaved?: (agent: AgentProfileRead) => void;
  currentUser?: EnterpriseAuthUser;
}) {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const [form, setForm] = useState<EmployeeProfileFormValues>(BLANK_FORM);
  const [saving, setSaving] = useState(false);
  const profile = useMemo(() => employeeProfile(agent), [agent]);

  /** Apply a partial form update without transforming raw employee-entered values. */
  const update = (patch: Partial<EmployeeProfileFormValues>) => setForm((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    if (!open || !agent) return;
    setForm({
      name: employeeDisplayName(agent),
      roleName: profile.roleName === '待补充岗位' ? '' : profile.roleName,
      onboardedAt: profile.onboardedAt === '-' ? new Date().toISOString().slice(0, 10) : profile.onboardedAt,
      description: agent.description || '',
      personaPrompt: agent.persona_prompt || '',
      systemPromptSummary: typeof agent.metadata?.system_prompt_summary === 'string' ? agent.metadata.system_prompt_summary : '',
      workStyles: profile.workStyles,
      expertiseTags: profile.expertiseTags,
      workModes: profile.workModes,
      harnessMaxActions: Math.max(1, Math.min(100, agent.harness_max_actions || 32)),
      status: agent.status === 'archived' ? 'archived' : 'active',
      publishedToGallery: agent.metadata?.published_to_gallery === true,
    });
  }, [agent, open, profile]);

  /** Persist the profile and route validation/API failures through stable localized descriptors. */
  async function save() {
    if (!agent) return;
    if (!form.name.trim()) {
      toast.error(createMessageDescriptor('employeeProfile.validation.nameRequired'));
      return;
    }
    setSaving(true);
    try {
      const wasPublished = agent.metadata?.published_to_gallery === true;
      const metadata: Record<string, unknown> = {
        ...(agent.metadata || {}),
        blank_onboarding: false,
        role_name: form.roleName.trim() || '待补充岗位',
        onboarded_at: form.onboardedAt || new Date().toISOString().slice(0, 10),
        system_prompt_summary: form.systemPromptSummary.trim(),
        work_styles: compactTags(form.workStyles),
        expertise_tags: compactTags(form.expertiseTags),
        work_modes: compactTags(form.workModes),
        published_to_gallery: form.publishedToGallery,
      };
      if (form.publishedToGallery && !wasPublished) {
        metadata.gallery_published_at = new Date().toISOString();
        metadata.gallery_published_by = currentUser?.username;
      }
      if (!form.publishedToGallery) {
        delete metadata.gallery_published_at;
        delete metadata.gallery_published_by;
      }

      const saved = await api.put<AgentProfileRead>(`/api/enterprise/agents/${agent.id}`, {
        tenant_id: TENANT_ID,
        name: form.name.trim(),
        description: form.description.trim(),
        persona_prompt: form.personaPrompt.trim(),
        status: form.status,
        harness_max_actions: Math.max(1, Math.min(100, form.harnessMaxActions || 32)),
        metadata,
      });
      toast.success(createMessageDescriptor('employeeProfile.toast.updated'));
      onSaved?.(saved);
      onClose();
      window.dispatchEvent(new Event('ultrarag-enterprise-agent-scope-refresh'));
    } catch (error) {
      const descriptor = backendErrorMessageDescriptor(error);
      toast.error(descriptor
        ? { id: descriptor.messageId, values: descriptor.values }
        : createMessageDescriptor('employeeProfile.toast.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <DialogContent
        aria-describedby={undefined}
        className="employee-profile-modal flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[860px]"
      >
        <DialogTitle className="px-[12px] text-[14px] font-normal leading-none text-[#757f9c]">
          {agent ? (
            <>
              <span>{t('employeeProfile.dialog.title')}</span>
              <span aria-hidden="true">{t('employeeProfile.dialog.titleSeparator')}</span>
              <RawIdentifier value={employeeDisplayName(agent)} />
            </>
          ) : t('employeeProfile.dialog.title')}
        </DialogTitle>

        <div className="min-h-0 flex-1 overflow-y-auto px-[12px]">
          <div className="employee-profile-editor">
            <div className="employee-profile-preview">
              <EmployeeAvatar agent={agent} size={92} />
              <div>
                <span className="m-0 block text-[12px] text-muted-foreground">{t('employeeProfile.preview.label')}</span>
                <h4 className="mt-[4px] mb-[6px] text-[18px] font-semibold text-[#18181a]">
                  {agent
                    ? <RawIdentifier value={employeeDisplayName(agent)} />
                    : t('employeeProfile.preview.fallbackName')}
                </h4>
                <span className="m-0 block text-[12px] text-muted-foreground">
                  <RawContent value={profile.roleName} />
                </span>
              </div>
              <span className="employee-profile-preview-icon"><IdcardOutlined /></span>
            </div>

            <div className="employee-profile-form flex flex-col gap-[14px]">
              <div className="employee-profile-form-grid">
                <LabeledField label={t('employeeProfile.field.name')}>
                  <Input value={form.name} placeholder={t('employeeProfile.placeholder.name')} onChange={(event) => update({ name: event.target.value })} />
                </LabeledField>
                <LabeledField label={t('employeeProfile.field.role')}>
                  <Input value={form.roleName} placeholder={t('employeeProfile.placeholder.role')} onChange={(event) => update({ roleName: event.target.value })} />
                </LabeledField>
                <LabeledField label={t('employeeProfile.field.onboardedAt')}>
                  <Input type="date" value={form.onboardedAt} onChange={(event) => update({ onboardedAt: event.target.value })} />
                </LabeledField>
                <LabeledField label={t('employeeProfile.field.status')}>
                  <Select value={form.status} onValueChange={(value) => update({ status: value as 'active' | 'archived' })}>
                    <SelectTrigger className={`${SELECT_TRIGGER_CLASS} w-full`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">{t('employeeProfile.status.active')}</SelectItem>
                      <SelectItem value="archived">{t('employeeProfile.status.archived')}</SelectItem>
                    </SelectContent>
                  </Select>
                </LabeledField>
              </div>

              <LabeledField label={t('employeeProfile.field.description')}>
                <Textarea rows={3} value={form.description} placeholder={t('employeeProfile.placeholder.description')} onChange={(event) => update({ description: event.target.value })} />
              </LabeledField>
              <LabeledField label={t('employeeProfile.field.summary')}>
                <Textarea rows={2} value={form.systemPromptSummary} placeholder={t('employeeProfile.placeholder.summary')} onChange={(event) => update({ systemPromptSummary: event.target.value })} />
              </LabeledField>
              <LabeledField label={t('employeeProfile.field.persona')}>
                <Textarea rows={4} value={form.personaPrompt} placeholder={t('employeeProfile.placeholder.persona')} onChange={(event) => update({ personaPrompt: event.target.value })} />
              </LabeledField>
              <LabeledField label={t('employeeProfile.field.defaultModel')}>
                <div className="flex min-h-10 items-center rounded-[10px] border border-[#e3e7f1] bg-[#f7f8fa] px-3 text-[13px] text-[#59627a]">
                  {t('employeeProfile.model.inherited')}
                </div>
                <span className="text-[11px] text-muted-foreground">{t('employeeProfile.model.hint')}</span>
              </LabeledField>

              <div className="rounded-[14px] border border-[#e3e7f1] bg-[#fafbfc] p-[14px]">
                <LabeledField label={t('employeeProfile.field.maxActions')}>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={form.harnessMaxActions}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      update({ harnessMaxActions: Number.isFinite(next) ? next : 32 });
                    }}
                  />
                </LabeledField>
                <p className="m-0 mt-[6px] text-[11px] leading-[1.5] text-muted-foreground">
                  {t('employeeProfile.maxActions.hint')}
                </p>
              </div>

              <div className="employee-profile-form-grid is-tags">
                <LabeledField label={t('employeeProfile.field.expertise')}>
                  <TagsField value={form.expertiseTags} options={EXPERTISE_OPTIONS} messageIds={EXPERTISE_MESSAGE_IDS} placeholder={t('employeeProfile.placeholder.tags')} onChange={(next) => update({ expertiseTags: next })} />
                </LabeledField>
                <LabeledField label={t('employeeProfile.field.workStyles')}>
                  <TagsField value={form.workStyles} options={STYLE_OPTIONS} messageIds={STYLE_MESSAGE_IDS} placeholder={t('employeeProfile.placeholder.tags')} onChange={(next) => update({ workStyles: next })} />
                </LabeledField>
                <LabeledField label={t('employeeProfile.field.workModes')}>
                  <TagsField value={form.workModes} options={WORK_MODE_OPTIONS} messageIds={WORK_MODE_MESSAGE_IDS} placeholder={t('employeeProfile.placeholder.tags')} onChange={(next) => update({ workModes: next })} />
                </LabeledField>
              </div>

              <div className="employee-profile-publish">
                <div>
                  <strong className="text-[13px] text-[#18181a]">{t('employeeProfile.gallery.label')}</strong>
                  <p className="m-0 mt-[4px] text-[12px] text-muted-foreground">
                    {t('employeeProfile.gallery.hint')}
                  </p>
                </div>
                <Switch checked={form.publishedToGallery} onCheckedChange={(next) => update({ publishedToGallery: next })} />
              </div>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-[8px] px-[12px]">
          <UIButton
            variant="outline"
            disabled={saving}
            onClick={onClose}
            className="h-[32px] min-w-[80px] whitespace-nowrap rounded-[10px] border-[#e3e7f1] bg-white px-[12px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-[#18181a]"
          >
            {t('employeeProfile.action.cancel')}
          </UIButton>
          <UIButton
            disabled={saving}
            onClick={() => void save()}
            className="h-[32px] min-w-[80px] whitespace-nowrap rounded-[10px] bg-[#18181a] px-[12px] text-[14px] font-normal text-white hover:bg-[#303030]"
          >
            {t('employeeProfile.action.save')}
          </UIButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Render a localized form label around a controlled editor field. */
function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-[6px]">
      <span className="text-[12px] font-medium text-[#464c5e]">{label}</span>
      {children}
    </label>
  );
}

function TagsField({
  value,
  options,
  messageIds,
  placeholder,
  onChange,
}: {
  value: string[];
  options: string[];
  messageIds: Record<string, MessageId>;
  placeholder?: string;
  onChange: (next: string[]) => void;
}) {
  const { t } = useAppIntl();
  const [draft, setDraft] = useState('');
  const addTags = (raw: string) => {
    const parts = raw.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    if (parts.length) onChange(Array.from(new Set([...value, ...parts])));
    setDraft('');
  };
  const removeTag = (tag: string) => onChange(value.filter((item) => item !== tag));
  const suggestions = options.filter((item) => !value.includes(item));

  return (
    <div className="flex flex-col gap-[8px]">
      <div className="flex min-h-[34px] flex-wrap items-center gap-[6px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[8px] py-[5px] transition-colors focus-within:border-[#18181a]">
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-[4px] rounded-[6px] bg-[#f2f3f7] px-[8px] py-[2px] text-[12px] text-[#18181a]"
          >
            <RawContent value={tag} />
            <button
              type="button"
              aria-label={t('employeeProfile.tags.remove')}
              onClick={() => removeTag(tag)}
              className="grid place-items-center text-[#858b9c] hover:text-[#18181a]"
            >
              <XIcon className="size-[12px]" />
            </button>
          </span>
        ))}
        <input
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          value={draft}
          placeholder={value.length ? '' : placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
              event.preventDefault();
              addTags(draft);
            } else if (event.key === 'Backspace' && !draft && value.length) {
              removeTag(value[value.length - 1]);
            }
          }}
          onBlur={() => draft.trim() && addTags(draft)}
          className="h-[22px] min-w-[80px] flex-1 bg-transparent text-[12px] text-[#17191f] outline-none placeholder:text-[#c0c6d4]"
        />
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-[6px]">
          {suggestions.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => addTags(item)}
              className="rounded-[6px] border-[0.5px] border-[#e3e7f1] px-[8px] py-[2px] text-[12px] text-[#858b9c] hover:border-[#18181a] hover:text-[#18181a]"
            >
              + {t(messageIds[item])}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Deduplicate and bound raw tag values before sending them to the backend. */
function compactTags(values: string[] | undefined): string[] {
  return Array.from(new Set((values || []).map((item) => item.trim()).filter(Boolean))).slice(0, 12);
}

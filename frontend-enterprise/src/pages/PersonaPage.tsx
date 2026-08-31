import { SaveOutlined, UserOutlined } from '../icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Button as UIButton,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Textarea,
  notify,
} from '@/components/ui';
import { RawContent } from '@/i18n/RawContent';
import type { AppTranslator } from '@/i18n/imperative';
import type { MessageId } from '@/i18n/types';
import { useAppIntl } from '@/i18n/useAppIntl';
import { apiErrorMessage } from '@/lib/apiErrorMessages';

import { api, TENANT_ID } from '../api/client';
import { isTeamScope, readEmployeeScope } from '../lib/agent-scope-storage';
import type { AgentProfileRead, PersonaRead } from '../types';

type PersonaForm = {
  agent_name: string;
  agent_description: string;
  system_prompt: string;
};

const BLANK_PERSONA: PersonaForm = { agent_name: '', agent_description: '', system_prompt: '' };

/** 使用当前 locale 格式化更新时间，避免固定 ISO 文本进入 UI。 */
function formatDateOnly(value: string, locale: 'zh-CN' | 'en-US'): string {
  const normalized = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 10);
  }
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** 把未知异常收敛为安全语义文案，不把原始 Error.message 暴露给最终用户。 */
function personaErrorMessage(
  error: unknown,
  fallbackId: MessageId,
  translate: AppTranslator['t'],
): string {
  const message = apiErrorMessage(error, fallbackId, { t: translate });
  return message === translate('common.error.generic') ? translate(fallbackId) : message;
}

export default function PersonaPage() {
  const { locale, t } = useAppIntl();
  const [form, setForm] = useState<PersonaForm>(BLANK_PERSONA);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState('');
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(readEmployeeScope);
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || null,
    [agents, selectedAgentId],
  );
  const isOverallPersona = !selectedAgent || selectedAgent.is_overall;

  /** 更新本地岗位人设表单，避免各字段各自维护 setState 逻辑。 */
  function updatePersona(patch: Partial<PersonaForm>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  useEffect(() => {
    void loadPersonaScope();
  }, []);

  useEffect(() => {
    const onScopeChange = (event: Event) => {
      const agentId = (event as CustomEvent<{ agentId?: string }>).detail?.agentId || '';
      if (agentId && !isTeamScope(agentId)) setSelectedAgentId(agentId);
    };
    window.addEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
    return () => window.removeEventListener('ultrarag-enterprise-agent-scope-change', onScopeChange);
  }, []);

  useEffect(() => {
    const agent = agents.find((item) => item.id === selectedAgentId);
    if (agent) {
      if (agent.is_overall) {
        api
          .get<PersonaRead>(`/api/enterprise/persona?tenant_id=${TENANT_ID}`)
          .then((row) => {
            setForm({
              agent_name: agent.name,
              agent_description: agent.description || '',
              system_prompt: agent.persona_prompt || row.system_prompt,
            });
            setUpdatedAt(agent.updated_at || row.updated_at);
          })
          .catch((error) => notify.error(personaErrorMessage(error, 'personaPage.error.loadScope', t)));
        return;
      }
      setForm({
        agent_name: agent.name,
        agent_description: agent.description || '',
        system_prompt: agent.persona_prompt || '',
      });
      setUpdatedAt(agent.updated_at);
      return;
    }
    api
      .get<PersonaRead>(`/api/enterprise/persona?tenant_id=${TENANT_ID}`)
      .then((row) => {
        setForm((prev) => ({ ...prev, system_prompt: row.system_prompt }));
        setUpdatedAt(row.updated_at);
      })
      .catch((error) => notify.error(personaErrorMessage(error, 'personaPage.error.loadScope', t)));
  }, [agents, selectedAgentId, t]);

  /** 加载当前可选员工作用域，并把非法/团队作用域回退到有效员工。 */
  async function loadPersonaScope() {
    try {
      const rows = await api.get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${TENANT_ID}`);
      setAgents(rows);
      setSelectedAgentId((current) => {
        const stored = readEmployeeScope();
        const candidate = current || stored || '';
        if (candidate && rows.some((agent) => agent.id === candidate)) return candidate;
        return rows.find((agent) => agent.is_overall)?.id || rows[0]?.id || '';
      });
    } catch (error) {
      notify.error(personaErrorMessage(error, 'personaPage.error.loadScope', t));
    }
  }

  /** 保存当前岗位人设到员工或组织级作用域，未知异常统一回退为安全语义错误。 */
  async function save() {
    if (!form.system_prompt.trim() || (selectedAgent && !form.agent_name.trim())) {
      notify.error(t('personaPage.error.requiredFields'));
      return;
    }
    setLoading(true);
    try {
      if (selectedAgent) {
        const row = await api.put<AgentProfileRead>(`/api/enterprise/agents/${selectedAgent.id}`, {
          tenant_id: TENANT_ID,
          name: form.agent_name,
          description: form.agent_description,
          persona_prompt: form.system_prompt,
          status: selectedAgent.status,
        });
        setAgents((prev) => prev.map((item) => (item.id === row.id ? { ...row, resources: item.resources } : item)));
        setUpdatedAt(row.updated_at);
        if (row.is_overall) {
          await api.put<PersonaRead>('/api/enterprise/persona', {
            tenant_id: TENANT_ID,
            system_prompt: form.system_prompt,
          });
        }
        window.dispatchEvent(new CustomEvent('ultrarag-enterprise-agent-scope-change', { detail: { agentId: row.id } }));
        notify.success(t(row.is_overall ? 'personaPage.toast.savedOverall' : 'personaPage.toast.saved'));
      } else {
        const row = await api.put<PersonaRead>('/api/enterprise/persona', {
          tenant_id: TENANT_ID,
          system_prompt: form.system_prompt,
        });
        setUpdatedAt(row.updated_at);
        notify.success(t('personaPage.toast.savedOverall'));
      }
    } catch (error) {
      notify.error(personaErrorMessage(error, 'personaPage.error.save', t));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h3>{t('personaPage.title')}</h3>
        </div>
        <UIButton disabled={loading} onClick={() => void save()}>
          <SaveOutlined />
          {t('personaPage.action.save')}
        </UIButton>
      </div>
      <Card className="editor-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-[6px]"><UserOutlined /> {t('personaPage.section.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-[14px]">
          <LabeledField label={t('personaPage.field.name')}>
            <Input
              value={form.agent_name}
              placeholder={t('personaPage.placeholder.name')}
              onChange={(event) => updatePersona({ agent_name: event.target.value })}
            />
          </LabeledField>
          <LabeledField label={t('personaPage.field.description')}>
            <Textarea
              rows={2}
              value={form.agent_description}
              placeholder={t('personaPage.placeholder.description')}
              onChange={(event) => updatePersona({ agent_description: event.target.value })}
            />
          </LabeledField>
          <LabeledField label={t('personaPage.field.prompt')}>
            <Textarea
              className="persona-editor"
              rows={12}
              value={form.system_prompt}
              placeholder={t(isOverallPersona ? 'personaPage.placeholder.overallPrompt' : 'personaPage.placeholder.scopedPrompt')}
              onChange={(event) => updatePersona({ system_prompt: event.target.value })}
            />
          </LabeledField>
          {updatedAt && (
            <span className="text-[12px] text-muted-foreground">
              {t('personaPage.updatedAt', { date: formatDateOnly(updatedAt, locale) })}
            </span>
          )}
          {selectedAgent && (
            <span className="sr-only">
              <RawContent value={selectedAgent.name} />
            </span>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function LabeledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-[6px]">
      <span className="text-[12px] font-medium text-[#464c5e]">{label}</span>
      {children}
    </label>
  );
}

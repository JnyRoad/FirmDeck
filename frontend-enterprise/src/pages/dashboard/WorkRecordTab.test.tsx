// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AppLocale } from '@/i18n/locales';
import type { AgentProfileRead } from '@/types';

import WorkRecordTab from './WorkRecordTab';

const localeCopy = {
  'zh-CN': {
    conversations: '对话次数',
    growth: '成长记录',
    knowledge: '知识库',
    logs: '对话日志',
    empty: '当日暂无活动记录',
    day: '日',
    week: '周',
    month: '月',
  },
  'en-US': {
    conversations: 'Conversations',
    growth: 'Growth log',
    knowledge: 'Knowledge bases',
    logs: 'Conversation logs',
    empty: 'No activity for this day',
    day: 'Day',
    week: 'Week',
    month: 'Month',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

const selectedAgent: AgentProfileRead = {
  id: 'agent-work-1',
  tenant_id: 'tenant_demo',
  name: 'Work Agent',
  description: 'Raw work agent description',
  is_overall: false,
  status: 'active',
  metadata: {},
  resources: [],
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

/** 在语义 Provider 下渲染工作记录页，验证 locale chrome 与 raw 资源摘要边界。 */
function renderWorkRecord(locale: AppLocale): void {
  render(
    <AppIntlProvider initialLocale={locale}>
      <MemoryRouter>
        <WorkRecordTab
          selectedAgent={selectedAgent}
          activeKnowledge={[{ id: 'kb-1', name: 'Raw KB', tenant_id: 'tenant_demo', status: 'active', metadata: {}, document_count: 0, bucket_count: 0, chunk_count: 0, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' }]}
          activeGeneralSkills={[]}
          activeSkills={[]}
          activeTools={[]}
          activeScheduledTasks={[]}
          employeeSessions={[]}
          conversationCount={12}
          activityEvents={[]}
          feedbackCount={4}
          positiveRate={80}
          negativeRate={20}
        />
      </MemoryRouter>
    </AppIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('WorkRecordTab semantic locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)('renders localized work-record chrome in %s', (locale) => {
    const copy = localeCopy[locale];
    renderWorkRecord(locale);

    expect(screen.getByRole('button', { name: copy.day })).toBeTruthy();
    expect(screen.getByRole('button', { name: copy.week })).toBeTruthy();
    expect(screen.getByRole('button', { name: copy.month })).toBeTruthy();
    expect(screen.getByText(copy.conversations)).toBeTruthy();
    expect(screen.getByText(copy.growth)).toBeTruthy();
    expect(screen.getByText(copy.knowledge)).toBeTruthy();
    expect(screen.getByText(copy.logs)).toBeTruthy();
    expect(screen.getByText(copy.empty)).toBeTruthy();
    expect(screen.getByText('Raw KB')).toBeTruthy();
  });
});

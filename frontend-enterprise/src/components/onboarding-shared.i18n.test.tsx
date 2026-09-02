// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider, type AppLocale } from '@/i18n';
import type { KnowledgeConceptRead, ModelConfigRead } from '@/types';

import BrandLogo from './BrandLogo';
import KnowledgeGraphCanvas from './KnowledgeGraphCanvas';
import { ModelConfigDropdown } from './ModelConfigDropdown';
import OnboardingGuide, { ONBOARDING_SEEN_KEY } from './OnboardingGuide';
import { Paginator } from './Paginator';
import QuickStartGuide, { QUICK_START_SEEN_KEY } from './QuickStartGuide';

const copy = {
  'zh-CN': {
    canvas: '知识图谱画布',
    closeGuide: '关闭引导',
    defaultModel: '默认',
    emptyGraph: '暂无知识图谱数据',
    next: '下一步',
    nextPage: '下一页',
    previousPage: '上一页',
    quickStartTitle: '配置模型 API Key',
    reset: '复位',
    welcome: '欢迎使用 StaffDeck',
    zoomIn: '放大',
  },
  'en-US': {
    canvas: 'Knowledge graph canvas',
    closeGuide: 'Close guide',
    defaultModel: 'Default',
    emptyGraph: 'No knowledge graph data',
    next: 'Next',
    nextPage: 'Next page',
    previousPage: 'Previous page',
    quickStartTitle: 'Configure a model API key',
    reset: 'Reset',
    welcome: 'Welcome to StaffDeck',
    zoomIn: 'Zoom in',
  },
} as const;

const concept = {
  id: 'concept-row-raw-id',
  tenant_id: 'tenant-raw-id',
  knowledge_base_id: 'knowledge-base-raw-id',
  concept_id: 'concept-raw-id',
  concept_type: 'Topic',
  title: '原始概念 Raw',
  content_md: '原始正文 / Raw body',
  frontmatter: {},
  links: [],
  citations: [],
  source_refs: [],
  status: 'active',
  created_at: '2026-08-30T00:00:00Z',
  updated_at: '2026-08-30T00:00:00Z',
} satisfies KnowledgeConceptRead;

const model = {
  id: 'model-config-raw-id',
  name: '模型原名 / Raw model',
  model: 'provider/model-raw-id',
  is_default: true,
} as ModelConfigRead;

/** 用明确 locale 渲染共享组件，避免测试继承 legacy provider 或浏览器偏好。 */
function renderWithLocale(locale: AppLocale, children: ReactNode): void {
  render(<AppIntlProvider locale={locale}>{children}</AppIntlProvider>);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('onboarding and shared UI locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes onboarding chrome and ARIA in %s',
    async (locale) => {
      window.localStorage.removeItem(ONBOARDING_SEEN_KEY);
      renderWithLocale(locale, <OnboardingGuide />);

      expect(screen.getByText(copy[locale].welcome)).toBeTruthy();
      expect(screen.getByRole('button', { name: copy[locale].closeGuide })).toBeTruthy();
      expect(screen.getAllByRole('button', { name: copy[locale].next }).length).toBeGreaterThan(0);
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'localizes quick-start chrome in %s',
    (locale) => {
      window.localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
      window.localStorage.removeItem(QUICK_START_SEEN_KEY);
      renderWithLocale(
        locale,
        <MemoryRouter initialEntries={['/enterprise/models']}>
          <QuickStartGuide isAdmin />
        </MemoryRouter>,
      );

      expect(screen.getByText(copy[locale].quickStartTitle)).toBeTruthy();
      expect(screen.getByRole('button', { name: copy[locale].closeGuide })).toBeTruthy();
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'localizes graph and pagination chrome while retaining raw business labels in %s',
    (locale) => {
      const { rerender } = render(
        <AppIntlProvider locale={locale}>
          <KnowledgeGraphCanvas concepts={[]} onSelectConcept={vi.fn()} />
        </AppIntlProvider>,
      );
      expect(screen.getByText(copy[locale].emptyGraph)).toBeTruthy();

      rerender(
        <AppIntlProvider locale={locale}>
          <KnowledgeGraphCanvas concepts={[concept]} onSelectConcept={vi.fn()} />
          <Paginator page={1} pageCount={2} onChange={vi.fn()} />
          <BrandLogo />
        </AppIntlProvider>,
      );

      expect(screen.getByRole('img', { name: copy[locale].canvas })).toBeTruthy();
      expect(screen.getByRole('button', { name: copy[locale].zoomIn })).toBeTruthy();
      expect(screen.getByRole('button', { name: copy[locale].reset })).toBeTruthy();
      expect(screen.getByRole('button', { name: copy[locale].previousPage })).toBeTruthy();
      expect(screen.getByRole('button', { name: copy[locale].nextPage })).toBeTruthy();
      expect(document.body.textContent).toContain(concept.title);
      expect(document.body.textContent).toContain('StaffDeck');
    },
  );

  it.each(['zh-CN', 'en-US'] as const)(
    'localizes the default-model marker while retaining model identifiers in %s',
    async (locale) => {
      const user = userEvent.setup();
      renderWithLocale(
        locale,
        <ModelConfigDropdown models={[model]} value={model.id} onChange={vi.fn()} />,
      );

      await user.click(screen.getByRole('button', { name: model.name }));
      expect(document.body.textContent).toContain(model.model);
      expect(document.body.textContent).toContain(copy[locale].defaultModel);
    },
  );
});

// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppIntlProvider, I18nProvider } from '@/i18n';

import { EditableCapabilityReferencesLine } from './DistillPage';

afterEach(cleanup);

describe('SOP capability references', () => {
  it('hides unavailable resources unless the node already references them', async () => {
    const user = userEvent.setup();

    render(
      <I18nProvider>
        <EditableCapabilityReferencesLine
          label="SOP 技能"
          values={[]}
          requiredValues={[]}
          options={[
            {
              value: 'skill_active',
              label: '可用技能',
              unavailableReason: undefined,
            },
            {
              value: 'skill_archived',
              label: '已停用技能',
              unavailableReason: '技能未启用',
            },
          ]}
          emptyText="未指定技能"
          onChange={vi.fn()}
          onRequiredChange={vi.fn()}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByRole('button', { name: /选择/ }));

    expect(screen.getByText('可用技能')).toBeTruthy();
    expect(screen.queryByText('已停用技能')).toBeNull();
  });

  it('removes an unavailable optional reference with one state update', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onRequiredChange = vi.fn();

    render(
      <I18nProvider>
        <EditableCapabilityReferencesLine
          label="SOP 工具"
          values={['tool_missing']}
          requiredValues={[]}
          options={[]}
          emptyText="未指定工具"
          onChange={onChange}
          onRequiredChange={onRequiredChange}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByRole('button', { name: /已选择 1 个/ }));
    await user.click(screen.getByRole('checkbox', { name: '取消选择tool_missing' }));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith([]);
    expect(onRequiredChange).not.toHaveBeenCalled();
  });

  it.each([
    ['zh-CN', '选择', '搜索SOP 工具', '可选执行', '强制执行'],
    ['en-US', 'Select', 'Search SOP 工具', 'Optional', 'Required'],
  ] as const)('localizes selector chrome in %s while preserving raw capability labels', async (
    locale,
    triggerText,
    searchPlaceholder,
    optionalText,
    requiredText,
  ) => {
    /** 产品控件应翻译；能力名称与不可用原因属于原始资源内容，必须原样保留。 */
    const user = userEvent.setup();

    render(
      <AppIntlProvider locale={locale}>
        <EditableCapabilityReferencesLine
          label="SOP 工具"
          values={['tool_raw_日本語']}
          requiredValues={[]}
          options={[
            {
              value: 'tool_raw_日本語',
              label: 'tool_raw_日本語',
              description: 'raw-description://工具',
            },
          ]}
          emptyText="未指定工具"
          onChange={vi.fn()}
          onRequiredChange={vi.fn()}
        />
      </AppIntlProvider>,
    );

    await user.click(screen.getByRole('button', { name: /tool_raw_日本語/ }));

    expect(screen.getByPlaceholderText(searchPlaceholder)).toBeTruthy();
    expect(screen.getAllByText('tool_raw_日本語').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(optionalText).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(requiredText).length).toBeGreaterThanOrEqual(1);
  });
});

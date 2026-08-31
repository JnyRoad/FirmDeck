// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AgentProfileRead } from '@/types';

import PlatformEmployeeDrawer from './PlatformEmployeeDrawer';

const employee: AgentProfileRead = {
  id: 'employee-1',
  tenant_id: 'tenant-demo',
  name: 'Raw employee name',
  description: 'Raw employee description',
  is_overall: false,
  status: 'active',
  metadata: {},
  resources: [],
  created_at: '2026-08-30T00:00:00Z',
  updated_at: '2026-08-30T00:00:00Z',
};

describe('PlatformEmployeeDrawer responsive actions', () => {
  it('keeps long English actions on one line without narrow fixed button widths', () => {
    render(
      <AppIntlProvider initialLocale="en-US">
        <PlatformEmployeeDrawer
          open
          agent={employee}
          platformTitle="Employee Marketplace"
          name="Raw employee name"
          role="Raw employee role"
          description="Raw employee description"
          detailText="Raw employee detail"
          workStyles={[]}
          stats={[
            { label: 'Knowledge', value: 2 },
            { label: 'Skills', value: 3 },
            { label: 'SOP', value: 2 },
          ]}
          canManage
          onClose={vi.fn()}
          onUnpublish={vi.fn()}
          onUse={vi.fn()}
          copy={{
            unpublishAction: 'Unpublish from marketplace',
            useAction: 'Use employee',
          }}
        />
      </AppIntlProvider>,
    );

    const unpublishButton = screen.getByRole('button', { name: 'Unpublish from marketplace' });
    const useButton = screen.getByRole('button', { name: 'Use employee' });

    expect(unpublishButton.className).toContain('whitespace-nowrap');
    expect(unpublishButton.className).not.toContain('w-[112px]');
    expect(useButton.className).toContain('whitespace-nowrap');
    expect(useButton.className).not.toContain('w-[80px]');
  });
});

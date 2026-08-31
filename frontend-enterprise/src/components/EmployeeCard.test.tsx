// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppIntlProvider } from '@/i18n/provider';
import type { AgentProfileRead } from '@/types';

import EmployeeCard from './EmployeeCard';

const employee: AgentProfileRead = {
  id: 'employee-project-manager',
  tenant_id: 'tenant-demo',
  name: '项目管理',
  description: 'Raw employee description',
  is_overall: false,
  status: 'active',
  metadata: {
    role_name: 'Project manager',
    avatar_preset: 'service-orbit',
  },
  resources: [],
  created_at: '2026-08-30T00:00:00Z',
  updated_at: '2026-08-30T00:00:00Z',
};

describe('EmployeeCard responsive header', () => {
  it('reserves the avatar width and lets identity text shrink before the avatar overlaps it', () => {
    render(
      <AppIntlProvider locale="en-US">
        <EmployeeCard
          employee={employee}
          canManage={false}
          showMenu={false}
          onOpen={vi.fn()}
          onStatus={vi.fn()}
          onGallery={vi.fn()}
          onDelete={vi.fn()}
          onAvatar={vi.fn()}
          onEdit={vi.fn()}
          onChat={vi.fn()}
        />
      </AppIntlProvider>,
    );

    const avatar = screen.getByLabelText('Employee avatar');
    const avatarSlot = avatar.parentElement?.parentElement;
    const identityColumn = avatarSlot?.nextElementSibling;

    expect(screen.getByText('Project manager')).toBeTruthy();

    expect(avatarSlot?.classList.contains('shrink-0')).toBe(true);
    expect(identityColumn?.classList.contains('min-w-0')).toBe(true);
  });

  it('centers English statistics and contains them inside narrow columns', () => {
    const { container } = render(
      <AppIntlProvider locale="en-US">
        <EmployeeCard
          employee={employee}
          canManage={false}
          showMenu={false}
          onOpen={vi.fn()}
          onStatus={vi.fn()}
          onGallery={vi.fn()}
          onDelete={vi.fn()}
          onAvatar={vi.fn()}
          onEdit={vi.fn()}
          onChat={vi.fn()}
        />
      </AppIntlProvider>,
    );

    const labels = Array.from(container.querySelectorAll('em'));
    expect(labels.map((label) => label.textContent)).toEqual(['Knowledge', 'Skills', 'SOP']);
    const statGrid = labels[0].parentElement?.parentElement;

    expect(statGrid?.className).toContain('overflow-hidden');
    for (const label of labels) {
      const statCell = label.parentElement;
      expect(statCell?.className).toContain('min-w-0');
      expect(statCell?.className).toContain('items-center');
      expect(statCell?.className).toContain('px-[4px]');
      expect(label.className).toContain('w-full');
      expect(label.className).toContain('text-center');
      expect(label.className).toContain('truncate');
      expect(statCell?.querySelector('strong')?.className).toContain('text-center');
    }
  });
});

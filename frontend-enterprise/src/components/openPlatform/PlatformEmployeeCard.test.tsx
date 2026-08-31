// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import PlatformEmployeeCard from './PlatformEmployeeCard';

function renderCard(onUnpublish?: () => void) {
  const onOpen = vi.fn();
  render(
    <PlatformEmployeeCard
      avatar={<span data-testid="employee-avatar">avatar</span>}
      name="Finance Employee"
      role="Finance"
      description="Handles finance workflows"
      stats={[{ label: 'SOP', value: 2 }]}
      onOpen={onOpen}
      onUnpublish={onUnpublish}
    />,
  );
  return { onOpen };
}

describe('PlatformEmployeeCard gallery governance', () => {
  it('uses the readable employee-card geometry shared by desktop galleries', () => {
    renderCard();

    const card = screen.getByRole('article');
    expect(card.className).toContain('h-[262px]');
    expect(screen.getByTestId('employee-avatar').parentElement?.className).toContain('w-[80px]');
    expect(screen.getByText('Finance Employee').className).toContain('text-[12px]');
    expect(screen.getByText('Handles finance workflows').className).toContain('text-[12px]');
  });

  it('does not expose the unpublish action without admin callback', () => {
    renderCard();
    expect(screen.queryByRole('button', { name: '从广场下线' })).toBeNull();
  });

  it('runs the unpublish action without opening employee details', async () => {
    const user = userEvent.setup();
    const onUnpublish = vi.fn();
    const { onOpen } = renderCard(onUnpublish);

    await user.click(screen.getByRole('button', { name: '从广场下线' }));

    expect(onUnpublish).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

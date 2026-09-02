// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { UnderlineTabs } from './underline-tabs';

describe('UnderlineTabs responsive labels', () => {
  it('keeps long localized labels on one line and exposes a horizontally safe tab list', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <UnderlineTabs
        aria-label="Employee categories"
        value="all"
        onChange={onChange}
        items={[
          { value: 'all', label: 'All employees' },
          { value: 'mine', label: 'My digital employees' },
          { value: 'teams', label: 'Team conversations' },
          { value: 'marketplace', label: 'Employee marketplace' },
        ]}
      />,
    );

    const tablist = screen.getByRole('tablist', { name: 'Employee categories' });
    expect(tablist.className).toContain('overflow-x-auto');

    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className).toContain('whitespace-nowrap');
      expect(tab.className).toContain('shrink-0');
    }

    await user.click(screen.getByRole('tab', { name: 'Team conversations' }));
    expect(onChange).toHaveBeenCalledWith('teams');
  });
});

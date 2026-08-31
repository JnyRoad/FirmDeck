// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PlatformResourceCard from './PlatformResourceCard';

afterEach(cleanup);

describe('PlatformResourceCard readable gallery layout', () => {
  it('uses a large card with readable title and description hierarchy', () => {
    render(
      <PlatformResourceCard
        title="Customer support knowledge"
        meta="12 documents"
        description="Answers common customer questions with sourced operational guidance."
        tags={['Support', 'Operations']}
      />,
    );

    const card = screen.getByRole('button');
    expect(card.className).toContain('h-[220px]');
    expect(screen.getByText('Customer support knowledge').className).toContain('text-[14px]');
    expect(screen.getByText(/Answers common customer questions/).className).toContain('text-[12px]');
  });

  it('keeps the entire card actionable', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <PlatformResourceCard
        title="Customer support knowledge"
        meta="12 documents"
        description="Operational guidance"
        onClick={onClick}
      />,
    );

    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('wraps a trailing tag instead of shrinking both tags onto one line', () => {
    const longVersion = '1.0.0-branch.agent_7d062081c03b4e16.1';
    const marketplaceLabel = 'Marketplace version';

    render(
      <PlatformResourceCard
        title="Customer support knowledge"
        meta="12 documents"
        description="Operational guidance"
        tags={[longVersion, marketplaceLabel]}
      />,
    );

    const firstTag = screen.getByText(longVersion);
    const trailingTag = screen.getByText(marketplaceLabel);
    expect(firstTag.parentElement).toBe(trailingTag.parentElement);
    expect(firstTag.parentElement?.className).toContain('flex-wrap');
    expect(firstTag.parentElement?.className).toContain('gap-y-[6px]');
    expect(firstTag.parentElement?.className).not.toContain('max-h-[48px]');
    expect(firstTag.className).toContain('max-w-full');
    expect(firstTag.className).toContain('shrink-0');
    expect(trailingTag.className).toContain('shrink-0');
    expect(trailingTag.className).toContain('max-w-full');
  });

  it('keeps a short leading tag at its content width', () => {
    render(
      <PlatformResourceCard
        title="Customer support knowledge"
        meta="12 documents"
        description="Operational guidance"
        tags={['1.0.0', 'Marketplace version']}
      />,
    );

    const leadingTag = screen.getByText('1.0.0');
    expect(leadingTag.className).toContain('shrink-0');
    expect(leadingTag.className).not.toContain('first:flex-1');
  });
});

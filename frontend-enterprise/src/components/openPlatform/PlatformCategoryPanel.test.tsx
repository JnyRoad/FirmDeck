// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import PlatformCategoryPanel from './PlatformCategoryPanel';

function renderPanel(cardSize: 'employee' | 'resource' = 'resource', loading = false) {
  return render(
    <PlatformCategoryPanel
      icon={<span>icon</span>}
      title="Marketplace"
      count={1}
      searchValue=""
      searchPlaceholder="Search marketplace"
      onSearchChange={() => undefined}
      loading={loading}
      cardSize={cardSize}
    >
      <div data-testid="marketplace-card">card</div>
    </PlatformCategoryPanel>,
  );
}

describe('PlatformCategoryPanel responsive density', () => {
  it('caps the gallery at four columns while preserving two columns on small desktops', () => {
    renderPanel();

    const grid = screen.getByTestId('marketplace-card').parentElement;
    expect(grid?.className).toContain('sm:grid-cols-2');
    expect(grid?.className).toContain('xl:grid-cols-3');
    expect(grid?.className).toContain('2xl:grid-cols-4');
    expect(grid?.className).not.toContain('2xl:grid-cols-5');
  });

  it.each([
    ['employee', 'h-[262px]'],
    ['resource', 'h-[220px]'],
  ] as const)('matches the %s card skeleton height', (cardSize, expectedHeight) => {
    const { container } = renderPanel(cardSize, true);
    const skeleton = container.querySelector('[data-platform-skeleton]');
    expect(skeleton?.className).toContain(expectedHeight);
  });
});

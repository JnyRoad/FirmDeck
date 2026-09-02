// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RawContent, RawIdentifier } from './RawContent';

describe('explicit raw-content boundaries', () => {
  /**
   * Verifies that source values remain byte-for-byte equivalent while product-owned siblings stay
   * outside the raw boundary. Rendering only changes the test DOM and has no external side effect.
   */
  it('preserves mixed content, URLs, paths, masked secrets, and Agent output verbatim', () => {
    const mixedContent = '知识库原文 / User input';
    const url = 'https://example.test/路径?q=中文&lang=en';
    const path = '/Users/lvtu/资料/README.md';
    const maskedSecret = 'sk-live-••••••••-9f3a';
    const agentOutput = 'Agent 原始产出: keep this response verbatim.';

    const { getByTestId } = render(
      <section data-testid="content-surface">
        <div data-testid="mixed-content"><RawContent value={mixedContent} /></div>
        <div data-testid="url"><RawContent value={url} /></div>
        <div data-testid="path"><RawContent value={path} /></div>
        <div data-testid="masked-secret"><RawIdentifier value={maskedSecret} /></div>
        <div data-testid="agent-output"><RawContent value={agentOutput} /></div>
        <span data-testid="adjacent-product-label">Copy source</span>
      </section>,
    );

    expect(getByTestId('mixed-content').textContent).toBe(mixedContent);
    expect(getByTestId('url').textContent).toBe(url);
    expect(getByTestId('path').textContent).toBe(path);
    expect(getByTestId('masked-secret').textContent).toBe(maskedSecret);
    expect(getByTestId('agent-output').textContent).toBe(agentOutput);
    expect(getByTestId('adjacent-product-label').textContent).toBe('Copy source');
  });

  /**
   * Verifies that a raw identifier is narrow enough not to suppress neighboring product semantics.
   * Rendering only changes the test DOM and has no external side effect.
   */
  it('does not place the raw boundary on a container that owns adjacent product text', () => {
    const identifier = '员工 / Employee #42';

    const { getByTestId } = render(
      <section data-testid="product-surface">
        <span data-testid="product-label">Employee details</span>
        <div data-testid="identifier"><RawIdentifier value={identifier} /></div>
        <button type="button">Copy identifier</button>
      </section>,
    );

    const surface = getByTestId('product-surface');
    expect(getByTestId('identifier').textContent).toBe(identifier);
    expect(surface.hasAttribute('data-i18n-ignore')).toBe(false);
    expect(getByTestId('product-label').textContent).toBe('Employee details');
    expect(surface.querySelector('button')?.textContent).toBe('Copy identifier');
  });
});

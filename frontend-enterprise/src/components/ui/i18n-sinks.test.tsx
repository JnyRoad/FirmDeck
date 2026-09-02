// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMessageDescriptor } from '@/i18n/descriptors';
import { createAppTranslator } from '@/i18n/imperative';
import { AppIntlProvider } from '@/i18n/provider';
import { RawContent } from '@/i18n/RawContent';
import { createUiSinks } from '@/i18n/sinks';

import { Input } from './input';
import { Textarea } from './textarea';

describe('semantic descriptors at DOM and non-DOM UI sinks', () => {
  /**
   * Verifies that form attributes accept a semantic descriptor and resolve it through the explicit
   * AppIntlProvider. The render operation is confined to the jsdom document.
   */
  it('localizes Input and Textarea placeholder, title, and accessible name from descriptors', () => {
    const saveMessage = createMessageDescriptor('common.action.save');

    const { getByTestId } = render(
      <AppIntlProvider initialLocale="en-US">
        <Input
          data-testid="message-input"
          placeholder={saveMessage}
          title={saveMessage}
          aria-label={saveMessage}
        />
        <Textarea
          data-testid="message-textarea"
          placeholder={saveMessage}
          title={saveMessage}
          aria-label={saveMessage}
        />
      </AppIntlProvider>,
    );

    const input = getByTestId('message-input');
    const textarea = getByTestId('message-textarea');
    expect(input.getAttribute('placeholder')).toBe('Save');
    expect(input.getAttribute('title')).toBe('Save');
    expect(input.getAttribute('aria-label')).toBe('Save');
    expect(textarea.getAttribute('placeholder')).toBe('Save');
    expect(textarea.getAttribute('title')).toBe('Save');
    expect(textarea.getAttribute('aria-label')).toBe('Save');
  });

  /**
   * Verifies that native dialog descriptors are translated by a controlled translator while the
   * prompt's default value remains raw source data. Browser dialog calls are mocked locally.
   */
  it('localizes alert, confirm, and prompt descriptors without translating raw defaults', () => {
    const translator = createAppTranslator('en-US');
    const sinks = createUiSinks(translator);
    const descriptor = createMessageDescriptor('common.action.save');
    const rawDefault = '知识库原文 / User input';
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const promptMock = vi.spyOn(window, 'prompt').mockReturnValue('用户原始输入');

    sinks.alert(descriptor);
    const confirmed = sinks.confirm(descriptor);
    const prompted = sinks.prompt(descriptor, rawDefault);

    expect(alertMock).toHaveBeenCalledWith('Save');
    expect(confirmMock).toHaveBeenCalledWith('Save');
    expect(confirmed).toBe(true);
    expect(promptMock).toHaveBeenCalledWith('Save', rawDefault);
    expect(prompted).toBe('用户原始输入');
  });

  /**
   * Verifies that a download sink localizes only its product-owned prefix and preserves the
   * user-supplied filename portion. DOM anchor creation and URL cleanup are mocked locally.
   */
  it('localizes download product text while retaining the raw filename segment', () => {
    const translator = createAppTranslator('en-US');
    const sinks = createUiSinks(translator);
    const descriptor = createMessageDescriptor('common.action.save');
    const rawName = '知识库-User input';
    const blob = new Blob(['raw source']);
    const createdAnchors: HTMLAnchorElement[] = [];
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:i18n-test');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const appendChild = vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
      if (node instanceof HTMLAnchorElement) createdAnchors.push(node);
      return node;
    });

    sinks.download(blob, descriptor, rawName, 'json');

    expect(createdAnchors[0]?.download).toBe('Save-知识库-User input.json');
    expect(createdAnchors[0]?.href).toBe('blob:i18n-test');
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:i18n-test');
    expect(appendChild).toHaveBeenCalled();
  });

  /**
   * Verifies that a raw source value remains unchanged under the semantic provider and does not
   * turn into a message key or suppress a neighboring product-owned label.
   */
  it('keeps RawContent outside semantic message lookup and preserves adjacent product text', () => {
    const rawSource = '知识库原文 / User input';

    const { getByTestId } = render(
      <AppIntlProvider initialLocale="en-US">
        <section data-testid="surface">
          <RawContent data-testid="raw-source" value={rawSource} />
          <span data-testid="product-label">Save source</span>
        </section>
      </AppIntlProvider>,
    );

    const surface = getByTestId('surface');
    const raw = getByTestId('raw-source');
    expect(raw.textContent).toBe(rawSource);
    expect(raw.getAttribute('data-i18n-raw-kind')).toBe('content');
    expect(raw.getAttribute('translate')).toBe('no');
    expect(surface.hasAttribute('data-i18n-ignore')).toBe(false);
    expect(getByTestId('product-label').textContent).toBe('Save source');
  });

  /**
   * Restores browser spies and removes rendered nodes so each sink test observes an isolated DOM.
   * Cleanup only mutates the local jsdom environment.
   */
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  /**
   * Confirms that a clean jsdom document is available before each test without changing application
   * locale or any production singleton.
   */
  beforeEach(() => {
    document.body.replaceChildren();
  });
});

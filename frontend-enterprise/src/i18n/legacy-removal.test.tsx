// @vitest-environment jsdom

/**
 * Locks the post-migration boundary: semantic React Intl owns locale state and no DOM translation
 * compatibility runtime remains in the frontend production tree.
 */

import fs from 'node:fs';
import path from 'node:path';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { I18nProvider, useAppIntl } from '@/i18n';

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');
const LEGACY_ROOT = path.join(SOURCE_ROOT, 'i18n', 'legacy');

/** Collect production TypeScript files without treating tests as runtime consumers. */
function collectProductionSources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectProductionSources(entryPath);
    if (!/\.tsx?$/.test(entry.name) || /\.(?:test|spec)\.tsx?$/.test(entry.name)) return [];
    return [entryPath];
  });
}

/** Render the real root provider and expose its semantic locale for the ownership assertion. */
function LocaleProbe() {
  const { locale } = useAppIntl();
  return <output data-testid="active-locale">{locale}</output>;
}

afterEach(() => cleanup());

describe('legacy i18n removal boundary', () => {
  it('removes the legacy directory and source-key catalog', () => {
    expect(fs.existsSync(LEGACY_ROOT)).toBe(false);
  });

  it('makes the root provider the only locale owner', () => {
    const source = fs.readFileSync(path.join(SOURCE_ROOT, 'i18n', 'index.ts'), 'utf8');
    expect(source).not.toMatch(/(?:from|import)\s+['"][^'"]*(?:\/legacy|\.\/legacy)['"]/);
    expect(source).not.toMatch(/\b(?:useI18n|useLegacyI18n|LegacyI18nProvider)\b/);

    render(
      <I18nProvider initialLocale="en-US">
        <LocaleProbe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('active-locale').textContent).toBe('en-US');
  });

  it('contains no coupled DOM translation observer in production sources', () => {
    const findings = collectProductionSources(SOURCE_ROOT)
      .filter((filePath) => {
        const source = fs.readFileSync(filePath, 'utf8');
        return /new\s+MutationObserver\s*\(/.test(source)
          && /new\s+WeakMap\s*</.test(source)
          && /\b(?:localize|translate)(?:TextNode|Attribute|Element|Subtree|Core)\b/.test(source);
      })
      .map((filePath) => path.relative(process.cwd(), filePath).split(path.sep).join('/'))
      .sort();

    expect(findings).toEqual([]);
  });
});

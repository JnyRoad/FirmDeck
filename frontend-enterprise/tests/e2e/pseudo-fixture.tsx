import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { createIntl, createIntlCache, RawIntlProvider } from 'react-intl';

import { AppIntlContext } from '../../src/i18n/provider';
import pseudoMessages from '../../src/i18n/generated/en-XA.json';
import type { MessageValues } from '../../src/i18n/imperative';
import type { MessageId } from '../../src/i18n/types';
import { useAppIntl } from '../../src/i18n/useAppIntl';

const RAW_BUSINESS_CONTENT = '知识库原文 / User supplied record';
const intl = createIntl(
  {
    locale: 'en-XA',
    defaultLocale: 'en-US',
    messages: pseudoMessages,
  },
  createIntlCache(),
);

/** Render long pseudo product chrome beside exact raw, iframe, dialog, and postMessage boundaries. */
function PseudoSurface() {
  const { t } = useAppIntl();
  const [status, setStatus] = useState(t('common.action.cancel'));

  /** Convert a product postMessage event into localized host status without copying remote text. */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'fixture_product_error') setStatus(t('common.error.generic'));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [t]);

  return (
    <main
      data-testid="pseudo-surface"
      style={{ boxSizing: 'border-box', maxWidth: '100vw', overflowWrap: 'anywhere', padding: 24 }}
    >
      <h1>{t('auth.login.productName')}</h1>
      <p data-testid="raw-business-content" data-i18n-raw-kind="business_record" translate="no">
        {RAW_BUSINESS_CONTENT}
      </p>
      <button
        type="button"
        onClick={() => window.prompt(t('common.action.cancel'), RAW_BUSINESS_CONTENT)}
      >
        Open native dialog
      </button>
      <iframe
        title={t('shell.nav.tools')}
        srcDoc={`<!doctype html><p>${RAW_BUSINESS_CONTENT}</p>`}
      />
      <p role="status" aria-live="polite">{status}</p>
    </main>
  );
}

/** Mount the test-only provider; en-XA never enters the production SupportedLocale registry. */
function mountPseudoFixture() {
  const t = (id: MessageId, values?: MessageValues) =>
    String(intl.formatMessage({ id }, values));
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <RawIntlProvider value={intl}>
      <AppIntlContext.Provider
        value={{ locale: 'en-XA' as never, setLocale: () => undefined, t }}
      >
        <PseudoSurface />
      </AppIntlContext.Provider>
    </RawIntlProvider>,
  );
}

mountPseudoFixture();

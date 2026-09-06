import { useIntl } from 'react-intl';

import { notify } from '@/components/ui/app-toast';
import { useI18n } from '@/i18n';

type InvalidSinkFixtureProps = {
  section: string;
};

/** Fixture containing one intentional violation for every governed TypeScript sink. */
export function InvalidSinkFixture({ section }: InvalidSinkFixtureProps) {
  const intl = useIntl();
  const { t } = useI18n();
  const dynamicId = `nav.${section}`;
  const clipboardNotice = (message: string) => message;
  document.title = 'FirmDeck settings';
  window.alert('Saved successfully');
  window.confirm('Delete this item?');
  window.prompt('Enter a title');
  notify.success('Saved successfully');
  clipboardNotice('Copied to clipboard');
  intl.formatMessage({ id: dynamicId });
  t('保存成功');
  new Intl.DateTimeFormat('zh-CN');
  Intl.NumberFormat('en-US').format(1000);
  window.postMessage({ type: 'product_error', message: 'Tool failed to load' }, '*');

  // i18n-ignore-next-line
  const unownedIgnore = 'product text';

  return (
    <section data-i18n-ignore>
      <h1>Account settings</h1>
      <input placeholder="Employee name" title="Employee name" aria-label="Employee name" />
      <img src="/avatar.png" alt="Employee avatar" />
      <iframe title="Embedded tool" src="about:blank" />
      <a download="FirmDeck-export.json" href="data:application/json,{}">
        Export report
      </a>
      <span>{unownedIgnore}</span>
    </section>
  );
}

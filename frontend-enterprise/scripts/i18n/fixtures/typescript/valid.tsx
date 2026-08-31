import { useIntl } from 'react-intl';

type ValidLocalizedPanelProps = {
  name: string;
};

/**
 * Renders a syntactically valid localized surface for governance checker fixtures.
 * The caller supplies raw display data, this function performs no I/O, and rendering fails if the
 * React Intl provider is absent.
 */
export function ValidLocalizedPanel({ name }: ValidLocalizedPanelProps) {
  const intl = useIntl();

  return (
    <section aria-label={intl.formatMessage({ id: 'fixture.panel.aria' })}>
      <h1>{intl.formatMessage({ id: 'fixture.panel.title' })}</h1>
      <p>{intl.formatMessage({ id: 'fixture.message.greeting' }, { name })}</p>
      <button type="button">{intl.formatMessage({ id: 'fixture.action.save' })}</button>
    </section>
  );
}

type Locale = 'zh-CN' | 'en-US';

type MessageId = 'fixture.locale.zh' | 'fixture.locale.en';

type RawRecord = {
  title: string;
};

const translate = (id: MessageId) => id;
const TECHNICAL_BY_LOCALE = {
  'zh-CN': 'GET',
  'en-US': 'POST',
} as const;

/** Fixture proving locale control, raw business data, technical enums, and Intl output stay valid. */
export function ValidLocaleFormatting({
  locale,
  count,
  raw,
}: {
  locale: Locale;
  count: number;
  raw: RawRecord;
}) {
  const localizedMessage = translate(locale === 'zh-CN' ? 'fixture.locale.zh' : 'fixture.locale.en');
  const localizedNumber = new Intl.NumberFormat(locale).format(count);
  const rawTitle = raw.title;
  const method = TECHNICAL_BY_LOCALE[locale];

  return (
    <section>
      <p>{localizedMessage}</p>
      <p>{localizedNumber}</p>
      <p>{rawTitle}</p>
      <code>{method}</code>
    </section>
  );
}

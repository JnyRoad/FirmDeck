type Locale = 'zh-CN' | 'en-US';

type RawRecord = {
  name: string;
  title: string;
};

const DEMO_PAGE_COPY = {
  'zh-CN': {
    title: '演示页面',
    save: '保存成功',
  },
  'en-US': {
    title: 'Demo page',
    save: 'Saved successfully',
  },
} as const;

/** Return inline prose from an explicit locale if-statement; the checker must treat both branches as UI copy. */
function localeBranchFunction(locale: Locale): string {
  if (locale === 'zh-CN') return '继续';
  return 'Continue';
}

/** Fixture containing locale-copy, locale-branch, plural, and unit-concatenation violations. */
export function InvalidLocaleFormatting({
  locale,
  count,
  raw,
}: {
  locale: Locale;
  count: number;
  raw: RawRecord;
}) {
  const localeBranch = locale === 'zh-CN' ? '保存' : 'Save';
  const pluralBranch = count === 1 ? 'item' : 'items';
  const countSuffix = count + ' items';
  const sizeSuffix = `${count} KB`;
  const statementBranch = localeBranchFunction(locale);

  return (
    <section>
      <h1>{DEMO_PAGE_COPY[locale].title}</h1>
      <p>{localeBranch}</p>
      <p>{pluralBranch}</p>
      <p>{countSuffix}</p>
      <p>{sizeSuffix}</p>
      <p>{statementBranch}</p>
      <p>{raw.title}</p>
    </section>
  );
}

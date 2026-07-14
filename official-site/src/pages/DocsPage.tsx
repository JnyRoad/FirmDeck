import { useEffect, useLayoutEffect } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import BrandLogo from '@/components/BrandLogo';
import GitHubMark from '@/components/GitHubMark';
import { cn } from '@/lib/utils';

import { tutorialNavGroups, tutorialPages, tutorialShared } from './tutorialDocs';
import './docs.css';

type DocLang = 'zh' | 'en';

const pageById = Object.fromEntries(tutorialPages.map((page) => [page.id, page])) as Record<string, typeof tutorialPages[number]>;

const pageGroupById = Object.fromEntries(
  tutorialNavGroups.flatMap((group) => group.items.map((item) => [item.id, group])),
) as Record<string, typeof tutorialNavGroups[number]>;

const pageIds = tutorialPages.map((page) => page.id);

function toAppHref(htmlHref: string, lang: DocLang) {
  const matched = htmlHref.match(/^staffdeck_([a-z]+)\.html$/);
  if (!matched) return htmlHref;
  return `/docs/${matched[1]}?lang=${lang}`;
}

function renderPageHtml(html: string, lang: DocLang) {
  return html
    .replace(/href="(staffdeck_[a-z]+\.html)"/g, (_, href: string) => `href="${toAppHref(href, lang)}"`)
    .replace(/src="\.\/*staffdeck_introduce_assets\//g, 'src="/staffdeck_introduce_assets/');
}

export default function DocsPage() {
  const navigate = useNavigate();
  const { pageId = 'introduce' } = useParams();
  const [searchParams] = useSearchParams();
  const lang: DocLang = searchParams.get('lang')?.toLowerCase().startsWith('en') ? 'en' : 'zh';
  const page = pageById[pageId];

  if (!page) return <Navigate to={`/docs/introduce?lang=${lang}`} replace />;

  const currentGroup = pageGroupById[page.id];
  const pageIndex = pageIds.indexOf(page.id);
  const prevId = pageIds[pageIndex - 1];
  const nextId = pageIds[pageIndex + 1];
  const prev = prevId ? pageById[prevId] : null;
  const next = nextId ? pageById[nextId] : null;
  const labels = tutorialShared[lang];
  const pageHtml = renderPageHtml(page.content[lang], lang);

  const setLang = (nextLang: DocLang) => {
    navigate(`/docs/${page.id}?lang=${nextLang}`, { replace: true });
  };

  useEffect(() => {
    if (!('scrollRestoration' in window.history)) return;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [page.id, lang]);

  useEffect(() => {
    document.documentElement.lang = lang === 'en' ? 'en-US' : 'zh-CN';
  }, [lang]);

  return (
    <div className="docs-root" data-i18n-ignore>
      <header className="docs-topbar">
        <Link className="docs-brand" to="/">
          <BrandLogo markSize={28} />
        </Link>
        <nav className="docs-topnav" aria-label="StaffDeck">
          <Link to="/">{labels.home}</Link>
          <Link className="is-active" to={`/docs/${page.id}?lang=${lang}`}>{labels.docs}</Link>
        </nav>
        <div className="docs-top-actions">
          <a
            className="docs-icon-link"
            href="https://github.com/OpenBMB/URStaff"
            aria-label="GitHub"
            target="_blank"
            rel="noreferrer"
          >
            <GitHubMark size={18} />
          </a>
          <span className="docs-lang-switch" aria-label="Language">
            <button className={cn(lang === 'en' && 'is-active')} type="button" onClick={() => setLang('en')}>EN</button>
            <span>|</span>
            <button className={cn(lang === 'zh' && 'is-active')} type="button" onClick={() => setLang('zh')}>中文</button>
          </span>
        </div>
      </header>

      <div className="docs-layout">
        <aside className="docs-sidebar" key={`sidebar-${lang}-${page.id}`}>
          {tutorialNavGroups.map((group) => (
            <div className="docs-nav-group" key={group.title.zh}>
              <div className="docs-nav-title">{group.title[lang]}</div>
              {group.items.map((item) => (
                <Link
                  key={item.id}
                  className={cn('docs-nav-link', item.id === page.id && 'is-active')}
                  to={`/docs/${item.id}?lang=${lang}`}
                >
                  {item.label[lang]}
                </Link>
              ))}
            </div>
          ))}
        </aside>

        <main className="docs-main">
          <article className="docs-article markdown">
            <div className="docs-breadcrumbs">
              <Link to="/">{labels.breadcrumbHome}</Link>
              <span>/</span>
              <span>{currentGroup.title[lang]}</span>
              <span>/</span>
              <span>{page.title[lang]}</span>
            </div>

            <div dangerouslySetInnerHTML={{ __html: pageHtml }} />

            <nav className="docs-pager" aria-label="Docs pages">
              {prev ? (
                <Link to={`/docs/${prev.id}?lang=${lang}`}>
                  <span>{labels.prev}</span>
                  <strong>{prev.title[lang]}</strong>
                </Link>
              ) : <span />}
              {next ? (
                <Link className="is-next" to={`/docs/${next.id}?lang=${lang}`}>
                  <span>{labels.next}</span>
                  <strong>{next.title[lang]}</strong>
                </Link>
              ) : null}
            </nav>
          </article>

          <aside className="docs-toc">
            <div>{labels.tocTitle}</div>
            {page.toc[lang].map((item) => (
              <a href={`#${item.id}`} key={item.id}>{item.label}</a>
            ))}
          </aside>
        </main>
      </div>

      <footer className="docs-footer">{labels.footer}</footer>
    </div>
  );
}

import { BookOpenText, House } from 'lucide-react';
import { Link } from 'react-router-dom';

import publicCopy from '@/i18n/site.json';
import { cn } from '@/lib/utils';

import './publicPageTabs.css';

type PublicPageTabsProps = {
  active: 'home' | 'docs';
  language: 'zh' | 'en';
  className?: string;
};

const labels = {
  zh: { home: publicCopy['zh-CN'].scenes[0], docs: publicCopy['zh-CN'].hero.tutorial },
  en: { home: publicCopy['en-US'].scenes[0], docs: publicCopy['en-US'].hero.tutorial },
} as const;

export default function PublicPageTabs({ active, language, className }: PublicPageTabsProps) {
  const copy = labels[language];
  const docsHref = `/docs/introduce?lang=${language}`;

  return (
    <nav className={cn('public-page-tabs', className)} aria-label="StaffDeck">
      <Link className={cn(active === 'home' && 'is-active')} to="/" aria-current={active === 'home' ? 'page' : undefined}>
        <House aria-hidden />
        <span>{copy.home}</span>
      </Link>
      <Link className={cn(active === 'docs' && 'is-active')} to={docsHref} aria-current={active === 'docs' ? 'page' : undefined}>
        <BookOpenText aria-hidden />
        <span>{copy.docs}</span>
      </Link>
    </nav>
  );
}

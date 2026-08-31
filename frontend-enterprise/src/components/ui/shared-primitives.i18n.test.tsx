// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AppIntlProvider, type AppLocale } from '@/i18n';

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from './dialog';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from './pagination';
import { Sheet, SheetContent, SheetTitle } from './sheet';
import { SidebarProvider, SidebarRail, SidebarTrigger } from './sidebar';

const copy = {
  'zh-CN': {
    close: '关闭',
    more: '更多页面',
    next: '下一页',
    pagination: '分页',
    previous: '上一页',
    toggleSidebar: '切换侧边栏',
  },
  'en-US': {
    close: 'Close',
    more: 'More pages',
    next: 'Next page',
    pagination: 'Pagination',
    previous: 'Previous page',
    toggleSidebar: 'Toggle sidebar',
  },
} as const satisfies Record<AppLocale, Record<string, string>>;

/** 在指定 locale 下同时挂载共享原语，覆盖可见文案与 ARIA 边界。 */
function renderPrimitives(locale: AppLocale): void {
  render(
    <AppIntlProvider locale={locale}>
      <Dialog open>
        <DialogContent>
          <DialogTitle>Dialog fixture</DialogTitle>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
      <Sheet open>
        <SheetContent>
          <SheetTitle>Sheet fixture</SheetTitle>
        </SheetContent>
      </Sheet>
      <Pagination>
        <PaginationContent>
          <PaginationItem><PaginationPrevious href="#previous" /></PaginationItem>
          <PaginationItem><PaginationEllipsis /></PaginationItem>
          <PaginationItem><PaginationNext href="#next" /></PaginationItem>
        </PaginationContent>
      </Pagination>
      <SidebarProvider>
        <SidebarTrigger />
        <SidebarRail />
      </SidebarProvider>
    </AppIntlProvider>,
  );
}

afterEach(cleanup);

describe('shared UI primitive locale matrix', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'localizes dialog, sheet, pagination, and sidebar chrome in %s',
    (locale) => {
      renderPrimitives(locale);
      const expected = copy[locale];

      expect(screen.getAllByText(expected.close).length).toBeGreaterThan(0);
      expect(screen.getByRole('navigation', { name: expected.pagination, hidden: true })).toBeTruthy();
      expect(screen.getByRole('link', { name: expected.previous, hidden: true })).toBeTruthy();
      expect(screen.getByRole('link', { name: expected.next, hidden: true })).toBeTruthy();
      expect(document.body.textContent).toContain(expected.more);
      expect(screen.getAllByRole('button', { name: expected.toggleSidebar, hidden: true }).length)
        .toBeGreaterThan(0);
    },
  );
});

import type { ComponentType, CSSProperties, ReactNode, SVGProps } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LogOut, ShieldCheck } from 'lucide-react';

import IconCollapse from '@/assets/icons/header-collapse.svg?react';
import IconPassword from '@/assets/icons/profile-file.svg?react';
import IconPolicies from '@/assets/icons/action-toggle.svg?react';
import IconTenants from '@/assets/icons/sys-accounts.svg?react';
import BrandLogo from '@/components/BrandLogo';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import type { MessageId } from '@/i18n';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import { cn } from '@/lib/utils';
import type { SystemAdminRead } from '@/system-auth';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

type SystemNavItem = {
  path: string;
  labelId: MessageId;
  Icon: IconComponent;
};

const SYSTEM_NAV_ITEMS: SystemNavItem[] = [
  { path: '/system/tenants', labelId: 'system.tenants.title', Icon: IconTenants },
  { path: '/system/password-policies', labelId: 'system.passwordPolicies.title', Icon: IconPolicies },
  { path: '/system/change-password', labelId: 'system.passwordChange.title', Icon: IconPassword },
];

export type SystemLayoutProps = {
  children: ReactNode;
  systemAdmin: SystemAdminRead;
  onLogout: () => void;
};

/** Render one control-plane navigation item with route-derived active semantics. */
function SystemNavButton({ item, active }: { item: SystemNavItem; active: boolean }) {
  const { t } = useAppIntl();
  const label = t(item.labelId);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip={label}
        isActive={active}
        className={cn(
          'h-[40px] gap-[10px] rounded-[14px] px-[16px] py-[10px] text-[14px] text-sidebar-foreground',
          'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
          'data-active:bg-sidebar-accent data-active:font-normal data-active:text-sidebar-accent-foreground',
          'group-data-[collapsible=icon]:px-0!',
        )}
      >
        <Link to={item.path} aria-label={label} aria-current={active ? 'page' : undefined}>
          <item.Icon className="size-[16px]! shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate whitespace-nowrap group-data-[collapsible=icon]:hidden">
            {label}
          </span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Render the installation control-plane sidebar without tenant navigation or tenant state. */
function SystemSidebar({ systemAdmin }: { systemAdmin: SystemAdminRead }) {
  const { t } = useAppIntl();
  const location = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const displayName = systemAdmin.display_name?.trim() || systemAdmin.username;
  const collapsed = state === 'collapsed';

  return (
    <Sidebar
      collapsible="icon"
      className="overflow-hidden border-r border-sidebar-border bg-sidebar backdrop-blur-[9.5px] **:data-[slot=sidebar-inner]:bg-sidebar"
    >
      <SidebarHeader className="gap-[28px] px-[20px] pt-[42px] group-data-[collapsible=icon]:px-[16px]">
        <div className="flex items-center justify-between gap-3 group-data-[collapsible=icon]:flex-col">
          <BrandLogo markOnly={collapsed} wordmarkClassName="group-data-[collapsible=icon]:hidden" />
          <button
            type="button"
            onClick={toggleSidebar}
            title={t(collapsed ? 'sidebar.expand' : 'sidebar.collapse')}
            aria-label={t(collapsed ? 'sidebar.expand' : 'sidebar.collapse')}
            className="flex size-[28px] shrink-0 items-center justify-center rounded-[8px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <IconCollapse className={cn('size-[14px]!', collapsed ? 'rotate-90' : '-rotate-90')} />
          </button>
        </div>

        <div className="flex items-center gap-[10px] rounded-[14px] border border-[#dce7fb] bg-[#edf4ff] px-[12px] py-[10px] text-[#1a71ff] group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <ShieldCheck className="size-[16px] shrink-0" aria-hidden="true" />
          <span className="truncate text-[12px] font-semibold group-data-[collapsible=icon]:hidden">
            {t('system.layout.consoleLabel')}
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-[20px] pt-[12px] group-data-[collapsible=icon]:px-[16px]">
        <nav aria-label={t('system.layout.consoleLabel')}>
          <SidebarMenu className="gap-[8px]">
            {SYSTEM_NAV_ITEMS.map((item) => (
              <SystemNavButton
                key={item.path}
                item={item}
                active={location.pathname === item.path}
              />
            ))}
          </SidebarMenu>
        </nav>
      </SidebarContent>

      <SidebarFooter className="px-[20px] pb-[20px] group-data-[collapsible=icon]:px-[16px]">
        <div className="flex items-center gap-[10px] rounded-[14px] border border-[#e3e7f1] bg-white px-[10px] py-[9px] group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <span className="grid size-[30px] shrink-0 place-items-center rounded-[9px] bg-[#e5efff] text-[12px] font-semibold uppercase text-[#1a71ff]">
            <RawContent value={displayName.slice(0, 1)} />
          </span>
          <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <strong className="block truncate text-[12px] font-medium text-[#30343b]">
              <RawContent value={displayName} />
            </strong>
            <small className="mt-0.5 block truncate text-[10px] text-[#7d879a]">
              <RawIdentifier value={systemAdmin.username} />
            </small>
          </span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * Dedicated control-plane shell. It shares the tenant console's sidebar/content
 * composition while intentionally excluding tenant switching and tenant routes.
 */
export default function SystemLayout({ children, systemAdmin, onLogout }: SystemLayoutProps) {
  const { t } = useAppIntl();
  const displayName = systemAdmin.display_name?.trim() || systemAdmin.username;

  return (
    <SidebarProvider
      defaultOpen
      style={{ '--sidebar-width': '240px', '--sidebar-width-icon': '72px' } as CSSProperties}
      className="app-shell bg-[#f7f9fc] text-[#18181a]"
    >
      <SystemSidebar systemAdmin={systemAdmin} />

      <div className="flex min-h-svh min-w-0 flex-1 flex-col">
        <header className="flex min-h-[64px] shrink-0 items-center justify-between gap-4 border-b border-[#e6eaf1] bg-white px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger className="rounded-[9px] text-[#596579] hover:bg-[#f2f5fa]" />
            <span className="hidden h-5 w-px bg-[#e6eaf1] sm:block" aria-hidden="true" />
            <div className="hidden min-w-0 items-center gap-2 sm:flex">
              <ShieldCheck className="size-[15px] shrink-0 text-[#1a71ff]" aria-hidden="true" />
              <span className="truncate text-[12px] font-medium text-[#596579]">
                {t('system.layout.consoleLabel')}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <LanguageSwitcher />
            <div className="hidden h-8 items-center gap-2 rounded-[10px] border border-[#e6eaf1] bg-[#f8fafc] px-3 md:flex">
              <span className="grid size-5 place-items-center rounded-full bg-[#e5efff] text-[10px] font-semibold uppercase text-[#1a71ff]">
                <RawContent value={displayName.slice(0, 1)} />
              </span>
              <RawContent
                value={displayName}
                className="max-w-[180px] truncate text-[12px] font-medium text-[#464c5e]"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={t('system.layout.logout')}
              onClick={onLogout}
              className="h-8 gap-1.5 rounded-[9px] border-[#dfe5ef] bg-white px-2.5 text-[12px] text-[#464c5e] hover:border-[#c9d4e6] hover:bg-[#f8fafc]"
            >
              <LogOut className="size-[14px]" aria-hidden="true" />
              <span className="hidden sm:inline">{t('system.layout.logout')}</span>
            </Button>
          </div>
        </header>

        <div
          role="region"
          aria-label={t('system.layout.consoleLabel')}
          className="flex min-w-0 flex-1 flex-col overflow-y-auto px-5 py-7 sm:px-8 sm:py-8 lg:px-10"
        >
          {children}
        </div>
      </div>
    </SidebarProvider>
  );
}

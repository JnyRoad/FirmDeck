import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { User } from 'lucide-react';

import AppHeader from '@/components/AppHeader';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { Paginator } from '@/components/Paginator';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { notify } from '@/components/ui/app-toast';
import { createAppTranslator, getStoredLocale } from '@/i18n';
import { apiErrorMessage } from '@/lib/apiErrorMessages';
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_ITEM_DANGER_CLASS, MOBILE_CARD_CLASS, formatDateTime } from '@/lib/enterprise-ui';
import { cn } from '@/lib/utils';

import { createTenantClient } from '../api/tenant-client';
import IconAdd from '../assets/icons/add.svg?react';
import IconAccounts from '../assets/icons/sys-accounts.svg?react';
import IconClear from '../assets/icons/field-clear.svg?react';
import IconEdit from '../assets/icons/edit.svg?react';
import IconMore from '../assets/icons/more.svg?react';
import IconRefresh from '../assets/icons/refresh.svg?react';
import IconSearch from '../assets/icons/search.svg?react';
import IconTrash from '../assets/icons/trash.svg?react';
import type { EnterpriseAuthUser } from '../auth';
import { useTenantSession } from '../contexts/TenantSessionContext';
import { useClientPagination } from '../hooks/useClientPagination';
import { StatusBadge } from './scheduled-tasks/StatusBadge';

type EmployeeAccount = {
  id: string;
  tenant_id: string;
  username: string;
  display_name?: string;
  role: 'admin' | 'member';
  created_at?: string;
  updated_at?: string;
};

type AccountDraft = {
  displayName: string;
  password: string;
  role: 'admin' | 'member';
};

type AccountCreateDraft = {
  username: string;
  displayName: string;
  password: string;
  role: 'admin' | 'member';
};

const ACCOUNT_PAGE_SIZE = 10;

/** 为账号页非 Hook 场景提供稳定翻译器；缺省时回退到持久化 locale。 */
function currentAccountsTranslator() {
  return createAppTranslator(getStoredLocale());
}

/** 将账号角色映射为稳定语义文案，避免 JSX 直接写产品字符串。 */
function accountRoleLabel(role: EmployeeAccount['role']): string {
  const { t } = currentAccountsTranslator();
  return role === 'admin' ? t('accountsPage.role.admin') : t('accountsPage.role.member');
}

/** 优先复用稳定错误码映射，未知错误回退到账号管理页安全文案。 */
function accountPageErrorMessage(
  error: unknown,
  fallbackId:
    | 'accountsPage.toast.loadFailed'
    | 'accountsPage.toast.createFailed'
    | 'accountsPage.toast.saveFailed'
    | 'accountsPage.toast.deleteFailed',
): string {
  const { t } = currentAccountsTranslator();
  const message = apiErrorMessage(error, fallbackId, { t });
  return message === t('common.error.generic') ? t(fallbackId) : message;
}

export function AccountRoleBadge({ role }: { role: EmployeeAccount['role'] }) {
  return (
    <StatusBadge tone={role === 'admin' ? 'blue' : 'gray'}>
      {accountRoleLabel(role)}
    </StatusBadge>
  );
}

/** 渲染账号列表和增删改对话框；原始用户名/显示名只作为运行时数据展示。 */
export default function AccountsPage({
  currentUser,
  onLogout,
}: {
  currentUser?: EnterpriseAuthUser;
  onLogout?: () => void;
} = {}) {
  const { t } = currentAccountsTranslator();
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const [rows, setRows] = useState<EmployeeAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [editing, setEditing] = useState<EmployeeAccount | null>(null);
  const [draft, setDraft] = useState<AccountDraft>({ displayName: '', password: '', role: 'member' });
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<AccountCreateDraft>({
    username: '',
    displayName: '',
    password: '',
    role: 'member',
  });
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EmployeeAccount | null>(null);
  const [deleting, setDeleting] = useState(false);

  /** 读取当前租户账号列表；未知错误不展示原始异常正文。 */
  async function load() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setLoading(true);
    try {
      const result = await tenantApi.get<EmployeeAccount[]>('/api/auth/users');
      if (!context.isCurrentGeneration(generation)) return;
      setRows(result);
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(accountPageErrorMessage(error, 'accountsPage.toast.loadFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [tenantApi]);

  const filteredRows = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    if (!keyword) return rows;
    return rows.filter((row) =>
      [row.username, row.display_name || '', accountRoleLabel(row.role)]
        .some((value) => value.toLowerCase().includes(keyword)),
    );
  }, [rows, searchText]);

  const pagination = useClientPagination(filteredRows, ACCOUNT_PAGE_SIZE, searchText);

  /** 打开编辑对话框并用当前账号值初始化草稿。 */
  function openEdit(row: EmployeeAccount) {
    setEditing(row);
    setDraft({ displayName: row.display_name || row.username, password: '', role: row.role });
  }

  /** 打开新建对话框并重置创建草稿。 */
  function openCreate() {
    setCreateDraft({ username: '', displayName: '', password: '', role: 'member' });
    setCreateOpen(true);
  }

  /** 创建账号；前端只做最小必填校验，其余使用后端稳定错误码。 */
  async function saveCreate() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    const username = createDraft.username.trim();
    const password = createDraft.password.trim();
    if (!username || !password) {
      notify.error(t('accountsPage.toast.requiredFields'));
      return;
    }
    setCreating(true);
    try {
      await tenantApi.post('/api/auth/users', {
        username,
        password,
        display_name: createDraft.displayName.trim() || username,
        role: createDraft.role,
      });
      if (!context.isCurrentGeneration(generation)) return;
      notify.successText(t('accountsPage.toast.created'));
      setCreateOpen(false);
      await load();
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(accountPageErrorMessage(error, 'accountsPage.toast.createFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setCreating(false);
    }
  }

  /** 保存账号编辑；密码留空时保留现有值。 */
  async function saveEdit() {
    if (!editing) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setSaving(true);
    try {
      await tenantApi.put(`/api/auth/users/${editing.id}`, {
        display_name: draft.displayName.trim() || editing.username,
        password: draft.password.trim() || undefined,
        role: draft.role,
      });
      if (!context.isCurrentGeneration(generation)) return;
      notify.successText(t('accountsPage.toast.saved'));
      setEditing(null);
      await load();
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(accountPageErrorMessage(error, 'accountsPage.toast.saveFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setSaving(false);
    }
  }

  /** 删除目标账号；管理员保护仍由禁用态与后端权限共同兜底。 */
  async function confirmDelete() {
    const row = deleteTarget;
    if (!row) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    setDeleting(true);
    try {
      await tenantApi.delete(`/api/auth/users/${row.id}`);
      if (!context.isCurrentGeneration(generation)) return;
      notify.successText(t('accountsPage.toast.deleted'));
      setDeleteTarget(null);
      await load();
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      notify.error(accountPageErrorMessage(error, 'accountsPage.toast.deleteFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setDeleting(false);
    }
  }

  /** 渲染账号行操作菜单，并保留管理员账号删除禁用态。 */
  function renderActions(row: EmployeeAccount) {
    const isProtected = row.role === 'admin';
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t('accountsPage.actions.menu')}
          className="ml-auto grid size-7 place-items-center rounded-[8px] text-[#1a71ff] transition-colors outline-none hover:bg-black/5 hover:text-[#4a8dff] focus-visible:bg-black/5"
        >
          <IconMore className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openEdit(row)}>
            <IconEdit />
            {t('accountsPage.actions.edit')}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="my-[2px] bg-[#eef0f4]" />
          <DropdownMenuItem
            variant="destructive"
            className={MENU_ITEM_DANGER_CLASS}
            disabled={isProtected}
            onSelect={() => setDeleteTarget(row)}
          >
            <IconTrash />
            {t('accountsPage.actions.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const columns: DataTableColumn<EmployeeAccount>[] = [
    {
      key: 'username',
      title: t('accountsPage.column.username'),
      width: 220,
      className: 'text-[#18181a]',
      render: (row) => (
        <span className="flex min-w-0 items-center gap-[8px]">
          <span className="grid size-[24px] shrink-0 place-items-center rounded-full bg-[#eef1fb] text-[#7e96dc]">
            <User className="size-[14px]" />
          </span>
          <span className="truncate font-medium">{row.username}</span>
        </span>
      ),
    },
    {
      key: 'display_name',
      title: t('accountsPage.column.displayName'),
      width: 200,
      render: (row) => <span className="block truncate">{row.display_name || row.username}</span>,
    },
    {
      key: 'role',
      title: t('accountsPage.column.role'),
      width: 120,
      render: (row) => <AccountRoleBadge role={row.role} />,
    },
    {
      key: 'created',
      title: t('accountsPage.column.createdAt'),
      width: 180,
      render: (row) => formatDateTime(row.created_at),
    },
    {
      key: 'updated',
      title: t('accountsPage.column.updatedAt'),
      width: 180,
      render: (row) => formatDateTime(row.updated_at),
    },
    {
      key: 'actions',
      title: t('accountsPage.column.actions'),
      width: 70,
      align: 'right',
      render: (row) => renderActions(row),
    },
  ];

  /** 渲染移动端账号卡片，并保留运行时账户数据原样显示。 */
  const renderMobileCard = (row: EmployeeAccount) => (
    <article className={MOBILE_CARD_CLASS} key={row.id}>
      <div className="flex min-w-0 items-start justify-between gap-[10px]">
        <span className="flex min-w-0 items-center gap-[8px]">
          <span className="grid size-[28px] shrink-0 place-items-center rounded-full bg-[#eef1fb] text-[#7e96dc]">
            <User className="size-[15px]" />
          </span>
          <span className="min-w-0">
            <strong className="block truncate text-[14px] font-semibold text-[#18181a]">{row.username}</strong>
            <span className="mt-[2px] block truncate text-[12px] text-[#858b9c]">{row.display_name || row.username}</span>
            <span className="mt-[6px] block">
              <AccountRoleBadge role={row.role} />
            </span>
          </span>
        </span>
        {renderActions(row)}
      </div>
      <div className="mt-[10px] flex items-center justify-between gap-[10px] text-[12px] text-[#858b9c]">
        <span>{t('accountsPage.mobile.createdAt', { value: formatDateTime(row.created_at) })}</span>
        <span>{t('accountsPage.mobile.updatedAt', { value: formatDateTime(row.updated_at) })}</span>
      </div>
    </article>
  );

  return (
    <div className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]" aria-busy={loading}>
      <AppHeader onLogout={onLogout} userName={currentUser?.username} title={t('accountsPage.title')} />

      <div className="mt-[20px] mb-[16px] flex items-center justify-end gap-[12px]">
        <UIButton
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
          className="h-[34px] gap-[4px] rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[20px] text-[12px] font-normal text-[#757f9c] hover:border-[#cbd3e6] hover:bg-white hover:text-[#18181a]"
        >
          <IconRefresh className={cn('size-[14px]', loading && 'animate-spin')} />
          {t('accountsPage.actions.refresh')}
        </UIButton>
        <UIButton
          onClick={openCreate}
          className="h-[34px] gap-[4px] rounded-[10px] bg-[#18181a] px-[20px] text-[12px] font-normal text-white hover:bg-[#303030]"
        >
          <IconAdd className="size-[14px]" />
          {t('accountsPage.actions.create')}
        </UIButton>
      </div>

      <div className="flex flex-col gap-[24px] rounded-[20px_20px_0_0] bg-white p-[18px_18px_24px_18px] shadow-[0_-4px_16px_0_rgba(0,0,0,0.05)]">
        <div className="flex flex-col gap-[18px]">
          <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
            <IconAccounts className="size-[14px] shrink-0" />
            <span className="text-[14px] font-normal leading-none">{t('accountsPage.list.title')}</span>
          </div>

          <label className="flex h-[34px] w-[300px] items-center gap-[8px] overflow-hidden rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[12px] transition-colors focus-within:border-[#18181a] max-[900px]:w-full">
            <IconSearch className="size-[14px] shrink-0 text-[#858b9c]" />
            <input
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              value={searchText}
              placeholder={t('accountsPage.search.placeholder')}
              onChange={(event) => setSearchText(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent text-[12px] text-[#17191f] outline-none placeholder:text-[#c0c6d4]"
            />
            {searchText && (
              <button
                type="button"
                aria-label={t('accountsPage.search.clear')}
                onClick={() => setSearchText('')}
                className="grid size-[16px] shrink-0 place-items-center text-[#c0c6d4] hover:text-[#858b9c]"
              >
                <IconClear className="size-[14px]" />
              </button>
            )}
          </label>

          <div className="grid gap-[10px] md:hidden">
            {filteredRows.length ? (
              pagination.pagedItems.map(renderMobileCard)
            ) : (
              <div className="py-[40px] text-center text-[13px] text-[#858b9c]">{t('accountsPage.empty')}</div>
            )}
          </div>

          <div className="hidden md:block">
            <DataTable
              aria-label={t('accountsPage.list.aria')}
              columns={columns}
              data={pagination.pagedItems}
              rowKey={(row) => row.id}
              loading={loading}
              emptyText={t('accountsPage.empty')}
            />
          </div>

          {filteredRows.length > 0 && (
            <Paginator
              aria-label={t('accountsPage.pagination.aria')}
              className="mt-0 mb-[6px]"
              page={pagination.page}
              pageCount={pagination.pageCount}
              onChange={pagination.setPage}
            />
          )}
        </div>
      </div>

      <AccountDialog
        open={createOpen}
        title={t('accountsPage.dialog.createTitle')}
        loading={creating}
        submitText={t('common.action.create')}
        username={{ value: createDraft.username, onChange: (value) => setCreateDraft((prev) => ({ ...prev, username: value })) }}
        displayName={createDraft.displayName}
        onDisplayNameChange={(value) => setCreateDraft((prev) => ({ ...prev, displayName: value }))}
        password={createDraft.password}
        onPasswordChange={(value) => setCreateDraft((prev) => ({ ...prev, password: value }))}
        role={createDraft.role}
        onRoleChange={(value) => setCreateDraft((prev) => ({ ...prev, role: value }))}
        passwordLabel={t('accountsPage.field.initialPassword')}
        onClose={() => setCreateOpen(false)}
        onSubmit={() => void saveCreate()}
      />

      <AccountDialog
        open={Boolean(editing)}
        title={editing ? t('accountsPage.dialog.editTitle', { name: editing.username }) : t('accountsPage.dialog.editTitleFallback')}
        loading={saving}
        submitText={t('common.action.save')}
        username={null}
        displayName={draft.displayName}
        onDisplayNameChange={(value) => setDraft((prev) => ({ ...prev, displayName: value }))}
        password={draft.password}
        onPasswordChange={(value) => setDraft((prev) => ({ ...prev, password: value }))}
        role={draft.role}
        onRoleChange={(value) => setDraft((prev) => ({ ...prev, role: value }))}
        roleDisabled={editing?.id === currentUser?.id}
        passwordLabel={t('accountsPage.field.newPassword')}
        passwordPlaceholder={t('accountsPage.field.passwordKeepExisting')}
        onClose={() => setEditing(null)}
        onSubmit={() => void saveEdit()}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        loading={deleting}
        title={deleteTarget ? t('accountsPage.confirm.delete.title', { name: deleteTarget.username }) : ''}
        description={t('accountsPage.confirm.delete.description')}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

/** 渲染账号创建/编辑表单，并复用统一字段语义文案。 */
function AccountDialog({
  open,
  title,
  loading,
  submitText,
  username,
  displayName,
  onDisplayNameChange,
  password,
  onPasswordChange,
  role,
  onRoleChange,
  roleDisabled = false,
  passwordLabel,
  passwordPlaceholder,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  loading: boolean;
  submitText: string;
  username: { value: string; onChange: (value: string) => void } | null;
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  role: 'admin' | 'member';
  onRoleChange: (value: 'admin' | 'member') => void;
  roleDisabled?: boolean;
  passwordLabel: string;
  passwordPlaceholder?: string;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = currentAccountsTranslator();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="flex w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[440px]"
      >
        <div className="flex items-center gap-[6px] px-[12px] text-[#757f9c]">
          <IconAccounts className="size-[14px] shrink-0" />
          <DialogTitle className="text-[14px] font-normal leading-none text-[#757f9c]">
            {title}
          </DialogTitle>
        </div>

        <div className="flex flex-col gap-[14px] px-[12px]">
          {username && (
            <LabeledField label={t('accountsPage.field.username')}>
              <Input
                value={username.value}
                placeholder={t('accountsPage.field.usernamePlaceholder')}
                onChange={(event) => username.onChange(event.target.value)}
              />
            </LabeledField>
          )}
          <LabeledField label={t('accountsPage.field.displayName')}>
            <Input
              value={displayName}
              placeholder={t('accountsPage.field.displayNamePlaceholder')}
              onChange={(event) => onDisplayNameChange(event.target.value)}
            />
          </LabeledField>
          <LabeledField label={passwordLabel}>
            <Input
              type="password"
              value={password}
              placeholder={passwordPlaceholder}
              onChange={(event) => onPasswordChange(event.target.value)}
            />
          </LabeledField>
          <LabeledField label={t('accountsPage.field.role')}>
            <Select
              value={role}
              disabled={roleDisabled}
              onValueChange={(value) => onRoleChange(value as 'admin' | 'member')}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">{t('accountsPage.role.member')}</SelectItem>
                <SelectItem value="admin">{t('accountsPage.role.admin')}</SelectItem>
              </SelectContent>
            </Select>
          </LabeledField>
        </div>

        <div className="flex items-center justify-end gap-[8px] px-[12px]">
          <UIButton
            variant="outline"
            disabled={loading}
            onClick={onClose}
            className="h-[32px] w-[80px] rounded-[10px] border-[#e3e7f1] bg-white px-[12px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-[#18181a]"
          >
            {t('common.action.cancel')}
          </UIButton>
          <UIButton
            disabled={loading}
            onClick={onSubmit}
            className="h-[32px] w-[80px] rounded-[10px] bg-[#18181a] px-[12px] text-[14px] font-normal text-white hover:bg-[#303030]"
          >
            {submitText}
          </UIButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 渲染带标签的输入区域，并复用统一布局。 */
function LabeledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-[6px]">
      <span className="text-[12px] font-medium text-[#464c5e]">{label}</span>
      {children}
    </label>
  );
}

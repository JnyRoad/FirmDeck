import { useEffect, useRef, useState } from 'react';

import { Button, Input } from '@/components/ui';
import { systemClient, type PasswordPolicy, type SystemClient, type SystemPasswordPolicies, type TenantPasswordPolicy } from '@/api/system-client';
import { useAppIntl } from '@/i18n/useAppIntl';

type PolicyClient = Pick<SystemClient, 'listTenants' | 'getPasswordPolicies' | 'updatePasswordPolicies' | 'getTenantPasswordPolicy' | 'updateTenantPasswordPolicy'>;
type SystemPasswordPoliciesPageProps = { client?: PolicyClient };

/** Edits installation defaults and an explicit per-tenant override as separate scopes. */
export default function SystemPasswordPoliciesPage({ client = systemClient }: SystemPasswordPoliciesPageProps) {
  const { t } = useAppIntl();
  const [policies, setPolicies] = useState<SystemPasswordPolicies | null>(null);
  const [tenants, setTenants] = useState<Array<{ id: string; display_name: string }>>([]);
  const [tenantId, setTenantId] = useState('');
  const [tenantPolicy, setTenantPolicy] = useState<TenantPasswordPolicy | null>(null);
  const [error, setError] = useState('');
  const tenantRequestRef = useRef(0);
  const selectedTenantRef = useRef('');

  /** Loads only control metadata and global policies, never tenant business data. */
  useEffect(() => {
    let cancelled = false;
    async function listAllTenants() {
      const items: Array<{ id: string; display_name: string }> = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTenants({ limit: 100, cursor });
        items.push(...page.items.map(({ id, display_name }) => ({ id, display_name })));
        cursor = page.next_cursor || undefined;
      } while (cursor);
      return items;
    }
    void Promise.all([client.getPasswordPolicies(), listAllTenants()])
      .then(([nextPolicies, nextTenants]) => {
        if (cancelled) return;
        setPolicies(nextPolicies);
        setTenants(nextTenants);
      })
      .catch(() => setError(t('system.passwordPolicies.loadError')));
    return () => { cancelled = true; };
  }, [client, t]);

  /** Fetches the selected tenant's inheritance state so custom policy is never implied. */
  function selectTenant(id: string) {
    selectedTenantRef.current = id;
    const requestId = ++tenantRequestRef.current;
    setTenantId(id);
    setTenantPolicy(null);
    if (!id) return;
    void client.getTenantPasswordPolicy(id).then((nextPolicy) => {
      if (selectedTenantRef.current === id && tenantRequestRef.current === requestId) {
        setTenantPolicy(nextPolicy);
      }
    }).catch(() => {
      if (selectedTenantRef.current === id && tenantRequestRef.current === requestId) {
        setError(t('system.passwordPolicies.loadError'));
      }
    });
  }

  /** Persists both installation policy scopes together, as required by the API contract. */
  function saveGlobal() {
    if (!policies) return;
    void client.updatePasswordPolicies(policies).then(setPolicies).catch(() => setError(t('system.passwordPolicies.saveError')));
  }

  /** Converts an inherited tenant into an explicit copy of the current effective policy. */
  function enableCustom() {
    if (!tenantPolicy) return;
    setTenantPolicy({ mode: 'custom', custom: tenantPolicy.effective, effective: tenantPolicy.effective });
  }

  /** Restores inheritance explicitly, instead of leaving an ambiguous empty custom payload. */
  function inheritDefault() {
    if (!tenantPolicy) return;
    setTenantPolicy({ ...tenantPolicy, mode: 'inherit', custom: null });
  }

  /** Saves the tenant mode and optional custom policy against the selected tenant only. */
  function saveTenant() {
    if (!tenantId || !tenantPolicy) return;
    const targetTenantId = tenantId;
    const requestId = ++tenantRequestRef.current;
    void client.updateTenantPasswordPolicy(targetTenantId, { mode: tenantPolicy.mode, custom: tenantPolicy.custom })
      .then((nextPolicy) => {
        if (
          selectedTenantRef.current === targetTenantId
          && tenantRequestRef.current === requestId
        ) {
          setTenantPolicy(nextPolicy);
        }
      }).catch(() => {
        if (
          selectedTenantRef.current === targetTenantId
          && tenantRequestRef.current === requestId
        ) {
          setError(t('system.passwordPolicies.saveError'));
        }
      });
  }

  return <main className="mx-auto flex w-full max-w-5xl flex-col gap-6"><header><h1 className="text-[27px] font-semibold">{t('system.passwordPolicies.title')}</h1><p className="mt-2 text-[13px] text-[#6f788a]">{t('system.passwordPolicies.description')}</p></header>{error && <p role="alert">{error}</p>}{!policies ? <p role="status">{t('system.passwordPolicies.loading')}</p> : <><section className="grid gap-4 md:grid-cols-2"><PolicyEditor title={t('system.passwordPolicies.systemTitle')} policy={policies.system} onChange={(system) => setPolicies({ ...policies, system })} /><PolicyEditor title={t('system.passwordPolicies.tenantDefaultTitle')} policy={policies.tenant_default} onChange={(tenant_default) => setPolicies({ ...policies, tenant_default })} /></section><Button type="button" onClick={saveGlobal}>{t('system.passwordPolicies.saveGlobal')}</Button><section className="rounded-[14px] border border-[#e3e8f1] p-5"><label className="grid gap-2"><span>{t('system.passwordPolicies.tenantSelect')}</span><select aria-label={t('system.passwordPolicies.tenantSelect')} value={tenantId} onChange={(event) => selectTenant(event.target.value)}><option value="">{t('system.passwordPolicies.tenantPlaceholder')}</option>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.display_name}</option>)}</select></label>{tenantPolicy && <div className="mt-5 grid gap-4"><p>{tenantPolicy.mode === 'inherit' ? t('system.passwordPolicies.inherited') : t('system.passwordPolicies.custom')}</p>{tenantPolicy.mode === 'inherit' ? <Button type="button" onClick={enableCustom}>{t('system.passwordPolicies.useCustom')}</Button> : <><PolicyEditor title={t('system.passwordPolicies.tenantOverrideTitle')} policy={tenantPolicy.custom || tenantPolicy.effective} onChange={(custom) => setTenantPolicy({ ...tenantPolicy, custom, effective: custom })} /><Button type="button" variant="outline" onClick={inheritDefault}>{t('system.passwordPolicies.inherit')}</Button></>}<Button type="button" onClick={saveTenant}>{t('system.passwordPolicies.saveTenant')}</Button></div>}</section></>}</main>;
}

type PolicyEditorProps = { title: string; policy: PasswordPolicy; onChange: (policy: PasswordPolicy) => void };

/** Presents policy fields with bounded numeric inputs and explicit complexity switches. */
function PolicyEditor({ title, policy, onChange }: PolicyEditorProps) {
  const { t } = useAppIntl();
  const setNumber = (field: 'min_length' | 'max_length', value: string) => onChange({ ...policy, [field]: Math.max(8, Math.min(20, Number(value) || 8)) });
  const setBoolean = (field: keyof Pick<PasswordPolicy, 'complexity_enabled' | 'require_uppercase' | 'require_lowercase' | 'require_digit' | 'require_special'>, value: boolean) => onChange({ ...policy, [field]: value });
  const toggles = [
    { field: 'complexity_enabled' as const, label: t('system.passwordPolicies.complexityEnabled') },
    { field: 'require_uppercase' as const, label: t('system.passwordPolicies.requireUppercase') },
    { field: 'require_lowercase' as const, label: t('system.passwordPolicies.requireLowercase') },
    { field: 'require_digit' as const, label: t('system.passwordPolicies.requireDigit') },
    { field: 'require_special' as const, label: t('system.passwordPolicies.requireSpecial') },
  ];
  return <section className="rounded-[14px] border border-[#e3e8f1] p-5"><h2 className="font-semibold">{title}</h2><div className="mt-4 grid gap-3 sm:grid-cols-2"><label>{t('system.passwordPolicies.minLength')}<Input type="number" min="8" max="20" value={policy.min_length} onChange={(event) => setNumber('min_length', event.target.value)} /></label><label>{t('system.passwordPolicies.maxLength')}<Input type="number" min="8" max="20" value={policy.max_length} onChange={(event) => setNumber('max_length', event.target.value)} /></label>{toggles.map(({ field, label }) => <label key={field}><input type="checkbox" checked={policy[field]} onChange={(event) => setBoolean(field, event.target.checked)} /> {label}</label>)}</div></section>;
}

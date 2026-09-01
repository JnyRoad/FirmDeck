import { useEffect, useState, type FormEvent } from 'react';

import { Button, Input } from '@/components/ui';
import { systemClient, type PasswordPolicy, type SystemClient } from '@/api/system-client';
import type { SystemAuthSession } from '@/system-auth';
import { useAppIntl } from '@/i18n/useAppIntl';

export type SystemPasswordChangePageProps = {
  session: SystemAuthSession;
  client?: Pick<SystemClient, 'changePassword' | 'getPasswordPolicies'>;
  onComplete: (session: SystemAuthSession) => void;
  forced: boolean;
};

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 20;
const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  min_length: MIN_PASSWORD_LENGTH,
  max_length: MAX_PASSWORD_LENGTH,
  complexity_enabled: false,
  require_uppercase: false,
  require_lowercase: false,
  require_digit: false,
  require_special: false,
};

/** Accept opaque credentials and exchange them for the replacement system session. */
export default function SystemPasswordChangePage({
  session: _session, client = systemClient, onComplete, forced,
}: SystemPasswordChangePageProps) {
  const { t } = useAppIntl();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [policy, setPolicy] = useState<PasswordPolicy>(DEFAULT_PASSWORD_POLICY);
  void _session;

  /** Loads the normal system-admin policy while restricted first-login sessions retain the fixed baseline. */
  useEffect(() => {
    if (forced) {
      setPolicy(DEFAULT_PASSWORD_POLICY);
      return;
    }
    let cancelled = false;
    void client.getPasswordPolicies()
      .then((policies) => {
        if (!cancelled) setPolicy(policies.system);
      })
      .catch(() => {
        if (!cancelled) setPolicy(DEFAULT_PASSWORD_POLICY);
      });
    return () => { cancelled = true; };
  }, [client, forced]);

  /** Clears password values immediately after any completed attempt. */
  function clearSecrets() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmation('');
  }

  /** Validates the active safe policy before sending a credential request. */
  function validate(): boolean {
    if (!currentPassword) {
      setError(t('system.passwordChange.currentRequired'));
      return false;
    }
    if (newPassword.length < policy.min_length || newPassword.length > policy.max_length) {
      setError(t('system.passwordChange.length', {
        min: policy.min_length,
        max: policy.max_length,
      }));
      return false;
    }
    if (policy.complexity_enabled && !hasRequiredComplexity(newPassword, policy)) {
      setError(t('system.passwordChange.complexity'));
      return false;
    }
    if (newPassword !== confirmation) {
      setError(t('system.passwordChange.mismatch'));
      return false;
    }
    return true;
  }

  /** Sends only the current and new password, then gives the verified replacement session to the shell. */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || !validate()) return;
    setLoading(true);
    setError('');
    try {
      const replacement = await client.changePassword({ current_password: currentPassword, new_password: newPassword });
      clearSecrets();
      onComplete(replacement);
    } catch {
      clearSecrets();
      setError(t('system.passwordChange.failure'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-5 py-12">
      <section className="w-full rounded-[18px] border border-[#e3e8f1] bg-white p-6 shadow-[0_18px_55px_rgba(35,61,102,0.08)] sm:p-9">
        <h1 className="text-[26px] font-semibold text-[#18181a]">{t(forced ? 'system.passwordChange.forcedTitle' : 'system.passwordChange.title')}</h1>
        <p className="mt-2 text-[13px] leading-5 text-[#6f788a]">{t(forced ? 'system.passwordChange.forcedDescription' : 'system.passwordChange.description')}</p>
        <form className="mt-7 grid gap-5" onSubmit={(event) => void submit(event)} noValidate aria-busy={loading}>
          <PasswordField id="system-current-password" label={t('system.passwordChange.current')} value={currentPassword} autoComplete="current-password" onChange={(value) => { setCurrentPassword(value); setError(''); }} />
          <PasswordField id="system-new-password" label={t('system.passwordChange.new')} value={newPassword} autoComplete="new-password" minLength={policy.min_length} maxLength={policy.max_length} onChange={(value) => { setNewPassword(value); setError(''); }} />
          <PasswordField id="system-confirm-password" label={t('system.passwordChange.confirm')} value={confirmation} autoComplete="new-password" onChange={(value) => { setConfirmation(value); setError(''); }} />
          <p className="text-[12px] text-[#6f788a]">{t('system.passwordChange.requirement', {
            min: policy.min_length,
            max: policy.max_length,
          })}</p>
          {!forced && policy.complexity_enabled && <ul className="text-[12px] text-[#6f788a]">{policy.require_uppercase && <li>{t('system.passwordPolicies.requireUppercase')}</li>}{policy.require_lowercase && <li>{t('system.passwordPolicies.requireLowercase')}</li>}{policy.require_digit && <li>{t('system.passwordPolicies.requireDigit')}</li>}{policy.require_special && <li>{t('system.passwordPolicies.requireSpecial')}</li>}</ul>}
          {error && <p role="alert" className="text-[13px] text-[#a73535]">{error}</p>}
          <Button type="submit" disabled={loading}>{loading ? t('system.passwordChange.submitting') : t('system.passwordChange.submit')}</Button>
        </form>
      </section>
    </main>
  );
}

type PasswordFieldProps = { id: string; label: string; value: string; autoComplete: string; minLength?: number; maxLength?: number; onChange: (value: string) => void };

/** Renders one non-persistent credential field without changing its opaque input bytes. */
function PasswordField({ id, label, value, autoComplete, minLength, maxLength, onChange }: PasswordFieldProps) {
  return <label className="grid gap-2 text-[13px] font-medium text-[#464c5e]" htmlFor={id}><span>{label}</span><Input id={id} type="password" aria-label={label} autoComplete={autoComplete} minLength={minLength} maxLength={maxLength} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

/** Tests only enabled complexity constraints without treating disabled requirements as mandatory. */
function hasRequiredComplexity(password: string, policy: PasswordPolicy): boolean {
  return (!policy.require_uppercase || /[A-Z]/.test(password))
    && (!policy.require_lowercase || /[a-z]/.test(password))
    && (!policy.require_digit || /\d/.test(password))
    && (!policy.require_special || /[^A-Za-z0-9]/.test(password));
}

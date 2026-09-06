import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';

import BrandLogo from '@/components/BrandLogo';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import { Button } from '@/components/ui/button';
import { systemClient, type SystemClient } from '@/api/system-client';
import type { SystemAuthSession } from '@/system-auth';
import { useAppIntl } from '@/i18n/useAppIntl';

export type SystemLoginPageProps = {
  client?: Pick<SystemClient, 'login'>;
  onLogin: (session: SystemAuthSession) => void;
};

/** Dedicated system administrator login; no tenant selector or public tenant directory is shown. */
export default function SystemLoginPage({ client = systemClient, onLogin }: SystemLoginPageProps) {
  const { t } = useAppIntl();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [usernameError, setUsernameError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [requestError, setRequestError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const normalizedUsername = username.trim();
    const nextUsernameError = normalizedUsername ? '' : t('system.login.usernameRequired');
    const nextPasswordError = password ? '' : t('system.login.passwordRequired');
    setUsernameError(nextUsernameError);
    setPasswordError(nextPasswordError);
    setRequestError('');
    if (nextUsernameError || nextPasswordError || loading) return;

    setLoading(true);
    try {
      // Only the username is normalized.  Password bytes, including leading or
      // trailing whitespace, are passed to the system client unchanged.
      const session = await client.login({ username: normalizedUsername, password });
      onLogin(session);
    } catch {
      // Keep upstream bodies, stack traces, and credentials out of the UI.
      setRequestError(t('system.login.denied'));
      setPassword('');
      setPasswordError('');
    } finally {
      setLoading(false);
    }
  }

  const fieldClass = 'h-11 rounded-[10px] border-[#dfe5ef] bg-white px-3.5 text-[14px] text-[#18181a] shadow-none placeholder:text-[#a0a8b8] focus-visible:border-[#1a71ff] focus-visible:ring-2 focus-visible:ring-[#1a71ff]/15';

  return (
    <div className="flex min-h-screen flex-col bg-[#f7f9fc] text-[#18181a]">
      <header className="flex h-[68px] items-center justify-between border-b border-[#e6eaf1] bg-white px-5 sm:px-8">
        <BrandLogo markSize={30} />
        <LanguageSwitcher />
      </header>

      <main className="flex flex-1 items-center justify-center px-5 py-12 sm:px-8">
        <section className="w-full max-w-[420px] rounded-[18px] border border-[#e3e8f1] bg-white p-6 shadow-[0_18px_55px_rgba(35,61,102,0.08)] sm:p-9">
          <div className="mb-8 flex flex-col items-center text-center">
            <span className="mb-4 grid size-11 place-items-center rounded-[13px] bg-[#e8f1ff] text-[#1a71ff]">
              <ShieldCheck className="size-5" aria-hidden="true" />
            </span>
            <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-[#18181a]">
              {t('system.login.title')}
            </h1>
            <p className="mt-2 text-[13px] leading-5 text-[#7d879a]">
              {t('system.login.subtitle')}
            </p>
          </div>

          <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)} noValidate>
            <div className="grid gap-2">
              <label htmlFor="system-username" className="text-[13px] font-medium text-[#464c5e]">
                {t('system.login.usernameLabel')}
              </label>
              <input
                id="system-username"
                name="username"
                type="text"
                value={username}
                autoComplete="username"
                placeholder={t('system.login.usernamePlaceholder')}
                aria-label={t('system.login.usernameLabel')}
                aria-invalid={usernameError ? 'true' : undefined}
                aria-describedby={usernameError ? 'system-username-error' : undefined}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setUsernameError('');
                  setRequestError('');
                }}
                className={fieldClass}
              />
              {usernameError && (
                <p id="system-username-error" className="text-[12px] text-[#c43b3b]">
                  {usernameError}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <label htmlFor="system-password" className="text-[13px] font-medium text-[#464c5e]">
                {t('system.login.passwordLabel')}
              </label>
              <div className="relative">
                <input
                  id="system-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  autoComplete="current-password"
                  placeholder={t('system.login.passwordPlaceholder')}
                  aria-label={t('system.login.passwordLabel')}
                  aria-invalid={passwordError ? 'true' : undefined}
                  aria-describedby={passwordError ? 'system-password-error' : undefined}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setPasswordError('');
                    setRequestError('');
                  }}
                  className={`${fieldClass} w-full pr-11`}
                />
                <button
                  type="button"
                  aria-label={showPassword ? t('system.login.hidePassword') : t('system.login.showPassword')}
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="absolute inset-y-0 right-0 grid w-11 place-items-center text-[#7d879a] outline-none transition-colors hover:text-[#464c5e] focus-visible:text-[#1a71ff]"
                >
                  {showPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
                </button>
              </div>
              {passwordError && (
                <p id="system-password-error" className="text-[12px] text-[#c43b3b]">
                  {passwordError}
                </p>
              )}
            </div>

            {requestError && (
              <div role="alert" className="rounded-[10px] border border-[#f2caca] bg-[#fff6f6] px-3 py-2.5 text-[13px] leading-5 text-[#a73535]">
                {requestError}
              </div>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="mt-1 h-11 w-full rounded-[10px] bg-primary text-[14px] text-white hover:bg-primary/80"
            >
              {loading ? t('system.login.loading') : t('system.login.submit')}
            </Button>
          </form>
        </section>
      </main>
    </div>
  );
}

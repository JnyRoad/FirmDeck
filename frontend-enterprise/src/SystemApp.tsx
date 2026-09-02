import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';

import { systemClient } from '@/api/system-client';
import SystemLayout from '@/components/system/SystemLayout';
import SystemLoginPage from '@/pages/SystemLoginPage';
import SystemPasswordChangePage from '@/pages/SystemPasswordChangePage';
import SystemPasswordPoliciesPage from '@/pages/SystemPasswordPoliciesPage';
import SystemTenantsPage from '@/pages/SystemTenantsPage';
import {
  clearSystemAuthSession,
  getSystemAuthSession,
  setSystemAuthSession,
  type SystemAuthSession,
} from '@/system-auth';
import { useAppIntl } from '@/i18n/useAppIntl';

/** Owns restore, verification, persistence, logout, and the system route subtree. */
export default function SystemApp() {
  const { t } = useAppIntl();
  const navigate = useNavigate();
  const [session, setSession] = useState<SystemAuthSession | null>(() => getSystemAuthSession());
  const [authChecked, setAuthChecked] = useState(() => !session?.token);

  useEffect(() => {
    if (!session?.token) {
      setAuthChecked(true);
      return undefined;
    }

    let cancelled = false;
    setAuthChecked(false);
    void systemClient.me()
      .then((systemAdmin) => {
        if (cancelled) return;
        const refreshed: SystemAuthSession = {
          token: session.token,
          scope: 'system',
          system_admin: systemAdmin,
        };
        try {
          setSystemAuthSession(refreshed);
          setSession(refreshed);
        } catch {
          clearSystemAuthSession();
          setSession(null);
        }
        setAuthChecked(true);
      })
      .catch(() => {
        if (cancelled) return;
        clearSystemAuthSession();
        setSession(null);
        setAuthChecked(true);
      });

    return () => {
      cancelled = true;
    };
  }, [session?.token]);

  /** Persists a verified login result and routes restricted sessions only to replacement. */
  function login(nextSession: SystemAuthSession) {
    setSystemAuthSession(nextSession);
    setSession(nextSession);
    setAuthChecked(true);
    navigate(nextSession.system_admin.must_change_password ? '/system/change-password' : '/system/tenants', { replace: true });
  }

  /** Removes the installation bearer and returns to the isolated system sign-in page. */
  function logout() {
    clearSystemAuthSession();
    setSession(null);
    setAuthChecked(true);
    navigate('/system/login', { replace: true });
  }

  /** Accepts the replacement bearer only after the server clears the mandatory-change flag. */
  function completePasswordChange(replacement: SystemAuthSession) {
    if (replacement.system_admin.must_change_password) return;
    setSystemAuthSession(replacement);
    setSession(replacement);
    navigate('/system/tenants', { replace: true });
  }

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f7f9fc] px-5">
        <div role="status" className="text-[13px] text-[#7d879a]">{t('system.loading')}</div>
      </div>
    );
  }

  if (!session) {
    return (
      <Routes>
        <Route path="/system/login" element={<SystemLoginPage onLogin={login} />} />
        <Route path="*" element={<Navigate to="/system/login" replace />} />
      </Routes>
    );
  }

  if (session.system_admin.must_change_password) {
    return <Routes><Route path="/system/change-password" element={<SystemPasswordChangePage session={session} onComplete={completePasswordChange} forced />} /><Route path="*" element={<Navigate to="/system/change-password" replace />} /></Routes>;
  }

  return (
    <Routes>
      <Route path="/system/login" element={<Navigate to="/system/tenants" replace />} />
      <Route path="/system/change-password" element={<SystemLayout systemAdmin={session.system_admin} onLogout={logout}><SystemPasswordChangePage session={session} onComplete={completePasswordChange} forced={false} /></SystemLayout>} />
      <Route path="/system/password-policies" element={<SystemLayout systemAdmin={session.system_admin} onLogout={logout}><SystemPasswordPoliciesPage /></SystemLayout>} />
      <Route
        path="/system/tenants"
        element={(
          <SystemLayout systemAdmin={session.system_admin} onLogout={logout}>
            <SystemTenantsPage />
          </SystemLayout>
        )}
      />
      <Route path="*" element={<Navigate to="/system/tenants" replace />} />
    </Routes>
  );
}

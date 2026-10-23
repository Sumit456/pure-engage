// OAuth consent screen: an AI assistant asks to connect; an admin picks what it may do, then approves or denies.
// Reached from /oauth/authorize (the API validates the request first and redirects here with the same query).
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Ban, Bot, HeartPulse, Link2 } from 'lucide-react';
import type { ApiScope } from '@pure-engage/shared';
import { api } from '../../api/client.ts';
import type { OAuthRequest } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { Button, ErrorBanner, Ltr, Spinner } from '../../components/ui.tsx';
import { scopeLabel } from './ApiKeysPage.tsx';

export function ConnectAuthorizePage() {
  const { t } = useTranslation();
  const user = useUser();
  const [params] = useSearchParams();
  const query = Object.fromEntries(params.entries());
  const info = useQuery({ queryKey: ['oauth-describe', params.toString()], enabled: hasRole(user, 'admin'), retry: false, queryFn: () => api<OAuthRequest>(`/api/oauth/describe?${params}`) });
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  useEffect(() => { if (info.data) setScopes(info.data.requested_scopes); }, [info.data]);
  const decide = useMutation({
    mutationFn: (approve: boolean) => api<{ redirect: string }>('/api/oauth/decide', { method: 'POST', body: { ...query, approve, scopes } }),
    onSuccess: (r) => window.location.assign(r.redirect),
  });
  const toggle = (s: ApiScope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <main className="pe-consent">
      <div className="pe-card pe-stack pe-consent__card">
        <div className="pe-consent__logos" aria-hidden="true">
          <span className="pe-consent__logo"><Bot /></span><Link2 className="pe-consent__link" /><span className="pe-consent__logo pe-consent__logo--brand"><HeartPulse /></span>
        </div>
        {!hasRole(user, 'admin') ? (
          <>
            <h1>{t('integrations.consent.adminTitle')}</h1>
            <p className="pe-muted">{t('integrations.consent.adminOnly')}</p>
            <Link to="/" className="pe-button pe-button--secondary">{t('integrations.consent.back')}</Link>
          </>
        ) : info.error ? (
          <>
            <h1>{t('integrations.consent.invalid')}</h1>
            <ErrorBanner error={info.error} />
          </>
        ) : !info.data ? <Spinner /> : (
          <>
            <h1>{t('integrations.consent.title', { name: info.data.client.name })}</h1>
            <p className="pe-muted">{t('integrations.consent.subtitle')} <Ltr><strong>{info.data.client.redirect_host}</strong></Ltr></p>
            <fieldset className="pe-fieldset">
              <legend>{t('integrations.consent.allow')}</legend>
              <div className="pe-stack pe-stack--tight">
                {info.data.available_scopes.map((s) => (
                  <label key={s} className="pe-check">
                    <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
                    <span>{scopeLabel(t, s)}<small className="pe-muted">{t(`integrations.consent.why.${s.replace(':', '_')}`)}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>
            {scopes.includes('contacts:read_pii') && <p className="pe-alert pe-alert--warning">{t('integrations.api.piiWarning')}</p>}
            <p className="pe-consent__never"><Ban aria-hidden="true" />{t('integrations.consent.never')}</p>
            <ErrorBanner error={decide.error} />
            <div className="pe-row pe-consent__actions">
              <Button onClick={() => decide.mutate(false)} disabled={decide.isPending}>{t('integrations.consent.deny')}</Button>
              <Button variant="primary" busy={decide.isPending} disabled={!scopes.length} onClick={() => decide.mutate(true)}>{t('integrations.consent.approve')}</Button>
            </div>
            <small className="pe-muted">{t('integrations.consent.revokeHint')}</small>
          </>
        )}
      </div>
    </main>
  );
}

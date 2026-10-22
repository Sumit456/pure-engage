import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client.ts';
import { useLogin, useMe } from '../auth/auth.tsx';
import { Button, TextField } from '../components/ui.tsx';
import { LANGUAGES } from '../i18n/index.ts';

export function Login() {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (me.data) return <Navigate to={from} replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => navigate(from, { replace: true }) });
  };

  const error = login.error instanceof ApiError
    ? login.error.status === 429 ? t('auth.tooManyAttempts') : login.error.status === 401 ? t('auth.invalidCredentials') : login.error.message
    : login.error ? t('errors.generic') : null;

  return (
    <div className="pe-login">
      <form className="pe-card pe-login__card" onSubmit={onSubmit} noValidate>
        <div className="pe-login__brand">
          <span className="pe-brand__mark" aria-hidden="true">PE</span>
          {t('app.name')}
        </div>
        <h1>{t('auth.signIn')}</h1>
        {error && <div className="pe-alert pe-alert--danger" role="alert">{error}</div>}
        <TextField label={t('auth.email')} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label={t('auth.password')} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="primary" busy={login.isPending} disabled={!email || !password}>{t('auth.signIn')}</Button>
        <div className="pe-row">
          {Object.entries(LANGUAGES).filter(([code]) => code !== i18n.language).map(([code, { label }]) => (
            <Button key={code} variant="ghost" onClick={() => void i18n.changeLanguage(code)}>{label}</Button>
          ))}
        </div>
      </form>
    </div>
  );
}

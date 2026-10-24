// API reference rendered from the served OpenAPI spec (/api/v1/openapi.json), so it never drifts from the contract.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Download, Search } from 'lucide-react';
import { api } from '../../api/client.ts';
import { ErrorBanner, Ltr, Spinner } from '../../components/ui.tsx';
import { PageHeader } from '../../components/bits.tsx';
import { BackLink, CodeBlock } from './common.tsx';

interface Operation {
  operationId: string; summary?: string; description?: string; tags?: string[]; 'x-scopes'?: string[];
  requestBody?: { content?: { 'application/json'?: { example?: unknown } } };
  parameters?: { name: string; in: string }[];
}
interface Spec { info: { title: string; version: string }; servers: { url: string }[]; paths: Record<string, Record<string, Operation>>; tags?: { name: string; description?: string }[] }

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export function ApiReferencePage() {
  const { t } = useTranslation();
  const spec = useQuery({ queryKey: ['openapi'], queryFn: () => api<Spec>('/api/v1/openapi.json'), staleTime: 5 * 60_000 });
  const [q, setQ] = useState('');
  const ops = useMemo(() => {
    if (!spec.data) return [];
    return Object.entries(spec.data.paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((m) => ({ path, method: m, op: item[m]! })));
  }, [spec.data]);
  const needle = q.trim().toLowerCase();
  const shown = ops.filter((o) => !needle || `${o.method} ${o.path} ${o.op.summary ?? ''} ${(o.op['x-scopes'] ?? []).join(' ')}`.toLowerCase().includes(needle));
  const tags = spec.data?.tags?.map((x) => x.name) ?? [];

  return (
    <section className="pe-stack">
      <BackLink to="/integrations">{t('nav.integrations')}</BackLink>
      <PageHeader
        title={t('integrations.cards.reference.title')}
        subtitle={t('integrations.reference.subtitle')}
        actions={<a className="pe-button pe-button--secondary" href="/api/v1/openapi.json" download="pure-engage-openapi.json"><Download aria-hidden="true" />{t('integrations.reference.download')}</a>}
      />
      {spec.error && <ErrorBanner error={spec.error} />}
      {!spec.data ? <Spinner /> : (
        <>
          <div className="pe-card pe-stack">
            <dl className="pe-dl">
              <dt>{t('integrations.reference.baseUrl')}</dt><dd><code><Ltr>{spec.data.servers[0]?.url}</Ltr></code></dd>
              <dt>{t('integrations.reference.auth')}</dt><dd><code><Ltr>Authorization: Bearer pe_…</Ltr></code></dd>
            </dl>
            <label className="pe-searchbox">
              <Search aria-hidden="true" />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('integrations.reference.search')} aria-label={t('integrations.reference.search')} />
            </label>
          </div>
          {tags.map((tag) => {
            const list = shown.filter((o) => o.op.tags?.includes(tag));
            if (!list.length) return null;
            return (
              <div key={tag} className="pe-stack">
                <h2>{tag}</h2>
                {list.map(({ path, method, op }) => {
                  const example = op.requestBody?.content?.['application/json']?.example;
                  const url = `${spec.data!.servers[0]?.url ?? ''}${path}`;
                  const curl = `curl -X ${method.toUpperCase()} '${url}' \\\n  -H "Authorization: Bearer $PE_API_KEY"${example !== undefined ? ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(example)}'` : ''}`;
                  return (
                    <details key={op.operationId} className="pe-card pe-endpoint" id={op.operationId}>
                      <summary>
                        <span className={`pe-method pe-method--${method}`}>{method.toUpperCase()}</span>
                        <code dir="ltr">{path}</code>
                        <span className="pe-muted">{op.summary}</span>
                      </summary>
                      <div className="pe-stack">
                        {op.description && <p className="pe-muted pe-prewrap">{op.description}</p>}
                        {!!op['x-scopes']?.length && (
                          <div className="pe-row"><strong>{t('integrations.reference.scopes')}</strong><div className="pe-scopechips">{op['x-scopes'].map((s) => <span key={s} className="pe-scopechip"><Ltr>{s}</Ltr></span>)}</div></div>
                        )}
                        <CodeBlock label="curl" code={curl} />
                      </div>
                    </details>
                  );
                })}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

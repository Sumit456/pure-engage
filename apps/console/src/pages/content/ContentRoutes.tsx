// Content editor routing: /content/<type>/<id|new> opens the right editor; old /templates links redirect here.
import { Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import type { Template } from '../../api/types.ts';
import { ErrorBanner, Spinner } from '../../components/ui.tsx';
import { ComingSoon } from '../ComingSoon.tsx';
import { TemplateEditorPage } from '../templates/TemplateEditorPage.tsx';
import { MessageEditorPage } from './MessageEditorPage.tsx';
import { BlockEditorPage } from './BlockEditorPage.tsx';

export function ContentEditorRoute() {
  const { channel, id } = useParams();
  // Keyed so switching between items (or from "new" to the saved item) starts from a clean editor.
  const key = `${channel}-${id === 'new' ? 'new' : 'edit'}`;
  switch (channel) {
    case 'email': case 'sms': return <TemplateEditorPage key={key} />;
    case 'push': case 'whatsapp': return <MessageEditorPage key={key} />;
    case 'block': return <BlockEditorPage key={key} />;
    default: return <ComingSoon section="content" />;
  }
}

export function TemplateRedirect() {
  const { id } = useParams();
  const tpl = useQuery({ queryKey: ['template-channel', id], enabled: id !== 'new', queryFn: ({ signal }) => api<Template>(`/api/templates/${id}`, { signal }) });
  if (id === 'new') return <Navigate to="/content/email/new" replace />;
  if (tpl.error) return <ErrorBanner error={tpl.error} />;
  if (!tpl.data) return <div className="pe-center"><Spinner /></div>;
  return <Navigate to={`/content/${tpl.data.channel}/${tpl.data.id}`} replace />;
}

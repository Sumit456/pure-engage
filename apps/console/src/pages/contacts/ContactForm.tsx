import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConsentMap } from '@pure-engage/shared';
import { api, ApiError } from '../../api/client.ts';
import type { Contact } from '../../api/types.ts';
import { Button, Dialog, ErrorBanner, TextField } from '../../components/ui.tsx';
import { ConsentMatrix } from './ConsentMatrix.tsx';

const FIELDS = ['external_id', 'first_name', 'last_name', 'email', 'phone', 'preferred_language', 'timezone'] as const;
type Field = (typeof FIELDS)[number];

/** Create (no `contact`) or edit a contact. Sends only changed fields; an emptied field is sent as null. */
export function ContactFormDialog({ open, contact, onClose, onSaved }: { open: boolean; contact?: Contact; onClose: () => void; onSaved?: (c: Contact) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const initial = Object.fromEntries(FIELDS.map((f) => [f, contact?.[f] ?? ''])) as Record<Field, string>;
  const [values, setValues] = useState(initial);
  const [consent, setConsent] = useState<ConsentMap>(contact?.consent ?? {});

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      for (const f of FIELDS) {
        const v = values[f].trim();
        if (v !== (initial[f] ?? '')) body[f] = v === '' ? null : v;
      }
      if (JSON.stringify(consent) !== JSON.stringify(contact?.consent ?? {})) body.consent = consent;
      return contact
        ? api<Contact>(`/api/contacts/${contact.id}`, { method: 'PATCH', body })
        : api<Contact>('/api/contacts', { method: 'POST', body });
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      void qc.invalidateQueries({ queryKey: ['contact', saved.id] });
      onSaved?.(saved);
      onClose();
    },
  });

  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const onSubmit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

  return (
    <Dialog open={open} onClose={onClose} title={contact ? t('contacts.edit') : t('contacts.new')}>
      <form className="pe-stack" onSubmit={onSubmit} noValidate>
        {save.error && !Object.keys(fieldErrors).length && <ErrorBanner error={save.error} />}
        <div className="pe-form-grid">
          {FIELDS.map((f) => (
            <TextField
              key={f}
              label={t(`contacts.field.${f}`)}
              value={values[f]}
              error={fieldErrors[f]}
              hint={f === 'phone' ? '+971500000001' : f === 'timezone' ? 'Asia/Dubai' : undefined}
              dir={f === 'email' || f === 'phone' || f === 'external_id' ? 'ltr' : undefined}
              onChange={(e) => setValues({ ...values, [f]: e.target.value })}
            />
          ))}
        </div>
        <div>
          <h3>{t('consent.title')}</h3>
          <ConsentMatrix value={consent} onChange={setConsent} />
        </div>
        <div className="pe-dialog__footer">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>{t('common.save')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

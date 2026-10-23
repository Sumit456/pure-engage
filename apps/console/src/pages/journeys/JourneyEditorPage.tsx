import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Archive, ChevronLeft, GripVertical, Pause, Rocket, Save, Trash2, X, Zap, type LucideIcon } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { journeyProblems, type Duration, type JourneyDefinition, type JourneyStep } from '@pure-engage/shared';
import { api, ApiError } from '../../api/client.ts';
import type { Contact, JourneyDetail, JourneyRun, SimulationStep, Template } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { ContactPicker } from '../../components/ContactPicker.tsx';
import { Badge, Button, ErrorBanner, Ltr, Spinner, TextField, useFormatDate } from '../../components/ui.tsx';
import { GroupEditor } from '../segments/RuleBuilder.tsx';
import { displayName } from '../contacts/ContactsPage.tsx';
import { JourneyStatusBadge } from './JourneysPage.tsx';
import { Pill, type Tone } from '../../components/bits.tsx';
import { autoLayout, JourneyCanvas, outputs, PALETTE, stepLook, TRIGGER_ID, type Layout, type PaletteItem, type StepType } from './JourneyCanvas.tsx';

const zero: Duration = { days: 0, hours: 0, minutes: 0 };
const newId = (type: StepType) => `${type}_${Math.random().toString(36).slice(2, 6)}`;

function newStep(type: StepType, templates: Template[], channel?: 'email' | 'sms'): JourneyStep {
  switch (type) {
    case 'send': return { type, template_id: templates.find((tpl) => !channel || tpl.channel === channel)?.id ?? '', next: null };
    case 'wait': return { type, duration: { ...zero, days: 1 }, next: null };
    case 'wait_until': return { type, property: 'start', offset: { ...zero, hours: -24 }, if_past: 'continue', next: null };
    case 'wait_for_event': return { type, event_name: '', timeout: { ...zero, days: 1 }, matched: null, timed_out: null };
    case 'split': return { type, condition: { type: 'group', op: 'and', rules: [] }, yes: null, no: null };
    case 'update': return { type, attributes: {}, next: null };
  }
}

const EMPTY: JourneyDefinition = { trigger: { event_name: 'purenet.appointment.booked' }, exit_on: [], start: '', steps: {} };

export function JourneyEditorPage() {
  return <ReactFlowProvider><JourneyEditor /></ReactFlowProvider>;
}

type PanelTab = 'checks' | 'test' | 'runs';

function JourneyEditor() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const { t } = useTranslation();
  const user = useUser();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const formatDate = useFormatDate();

  const journey = useQuery({ queryKey: ['journey', id], enabled: !isNew, queryFn: ({ signal }) => api<JourneyDetail>(`/api/journeys/${id}`, { signal }) });
  const runs = useQuery({ queryKey: ['journey', id, 'runs'], enabled: !isNew, queryFn: ({ signal }) => api<{ data: JourneyRun[] }>(`/api/journeys/${id}/enrollments`, { signal }) });
  const templates = useQuery({ queryKey: ['templates'], queryFn: ({ signal }) => api<{ data: Template[] }>('/api/templates', { signal }) });
  const tpls = templates.data?.data ?? [];

  const [name, setName] = useState('');
  const [def, setDef] = useState<JourneyDefinition>(EMPTY);
  const [layout, setLayout] = useState<Layout>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>('checks');
  const [path, setPath] = useState<string[]>([]);
  useEffect(() => {
    if (!journey.data) return;
    setName(journey.data.name);
    setDef(journey.data.definition);
    setLayout(autoLayout(journey.data.definition, journey.data.layout ?? {}));
  }, [journey.data]);

  const status = journey.data?.status ?? 'draft';
  const canEdit = hasRole(user, 'marketer') && (status === 'draft' || status === 'paused');
  const canArrange = hasRole(user, 'marketer') && status !== 'archived';
  const dirty = isNew || !journey.data || name !== journey.data.name || JSON.stringify(def) !== JSON.stringify(journey.data.definition);
  const problems = useMemo(() => (def.start ? journeyProblems(def) : [{ message: t('journeys.addFirstStep') }]), [def, t]);

  const refresh = (jid: string) => { void qc.invalidateQueries({ queryKey: ['journeys'] }); void qc.invalidateQueries({ queryKey: ['journey', jid] }); };
  const saveLayout = useMutation({ mutationFn: ({ jid, l }: { jid: string; l: Layout }) => api(`/api/journeys/${jid}/layout`, { method: 'PUT', body: { layout: l } }) });
  const save = useMutation({
    mutationFn: () => isNew ? api<JourneyDetail>('/api/journeys', { method: 'POST', body: { name, definition: def } }) : api<JourneyDetail>(`/api/journeys/${id}`, { method: 'PUT', body: { name, definition: def } }),
    onSuccess: async (j) => {
      await saveLayout.mutateAsync({ jid: j.id, l: pick(layout, def) });
      refresh(j.id);
      if (isNew) navigate(`/journeys/${j.id}`, { replace: true });
    },
  });
  const action = useMutation({
    mutationFn: (verb: 'activate' | 'pause' | 'archive') => verb === 'archive' ? api(`/api/journeys/${id}`, { method: 'DELETE' }) : api(`/api/journeys/${id}/${verb}`, { method: 'POST' }),
    onSuccess: (_r, verb) => { refresh(id!); if (verb === 'archive') navigate('/journeys'); },
  });

  // Positions are saved as soon as a drag ends (existing journeys) or with the first save (new ones).
  const onLayout = useCallback((l: Layout, persist: boolean) => {
    setLayout(l);
    if (persist && !isNew && id) saveLayout.mutate({ jid: id, l: pick(l, def) });
  }, [isNew, id, def, saveLayout]);

  const addStep = (item: PaletteItem, at?: { x: number; y: number }) => {
    const sid = newId(item.type);
    const step = newStep(item.type, tpls, item.channel);
    let next: JourneyDefinition = { ...def, steps: { ...def.steps, [sid]: step } };
    let pos = at;
    // Clicking (rather than dragging) adds the step after the selected one, on its first free output.
    if (!at) {
      const from = selected && (selected === TRIGGER_ID ? (!def.start ? TRIGGER_ID : null) : def.steps[selected] ? selected : null);
      let shift = 0;
      if (from === TRIGGER_ID) next = { ...next, start: sid };
      else if (from) {
        const parent = def.steps[from]!;
        const outs = outputs(parent);
        const free = outs.find((f) => !(parent as Record<string, unknown>)[f]);
        if (free) next = { ...next, steps: { ...next.steps, [from]: { ...parent, [free]: sid } as JourneyStep } };
        if (outs.length > 1 && free) shift = outs.indexOf(free) === 0 ? -150 : 150; // branches sit side by side
      }
      const base = (from && layout[from]) || { x: 0, y: Math.max(0, ...Object.values(layout).map((p) => p.y)) };
      pos = { x: base.x + shift, y: base.y + 150 };
      // Never drop a new step exactly on top of another one.
      while (Object.values(layout).some((p) => Math.abs(p.x - pos!.x) < 200 && Math.abs(p.y - pos!.y) < 90)) pos = { x: pos.x + 280, y: pos.y };
    }
    if (!next.start) next = { ...next, start: sid };
    setDef(next);
    setLayout({ ...layout, [sid]: pos! });
    setSelected(sid);
  };

  if (!isNew && journey.isPending) return <div className="pe-center"><Spinner /></div>;
  if (!isNew && journey.error) return <ErrorBanner error={journey.error} />;
  const serverProblems = journey.data && !dirty ? journey.data.problems : [];
  const allProblems = [...problems, ...serverProblems.filter((p) => !problems.some((q) => q.step === p.step && q.message === p.message))];
  const selectedStep = selected && selected !== TRIGGER_ID ? def.steps[selected] : undefined;
  const fieldErrors = save.error instanceof ApiError ? Object.entries(save.error.fieldErrors()) : [];

  return (
    <section className="pe-bleed pe-jeditor">
      <header className="pe-jeditor__bar">
        <Link to="/journeys" className="pe-icon-button" aria-label={t('journeys.backToList')}><ChevronLeft aria-hidden="true" className="pe-flip-rtl" /></Link>
        <div className="pe-jeditor__name">
          <h1 className="pe-visually-hidden">{isNew ? t('journeys.new') : name}</h1>
          <input aria-label={t('templates.field.name')} value={name} placeholder={t('journeys.canvas.namePlaceholder')} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
          <small className="pe-muted">{isNew ? t('journeys.canvas.unsaved') : dirty ? t('journeys.canvas.unsavedChanges') : t('journeys.canvas.saved', { when: formatDate(journey.data?.updated_at) })}</small>
        </div>
        {!isNew && <JourneyStatusBadge status={status} />}
        <span className="pe-spacer" />
        {allProblems.length > 0
          ? <Pill tone="warning">{t('journeys.canvas.problems', { count: allProblems.length })}</Pill>
          : <Pill tone="success" dot>{t('journeys.canvas.valid')}</Pill>}
        {canEdit && dirty && <Button variant="primary" busy={save.isPending} disabled={!name.trim() || !def.start} onClick={() => save.mutate()}><Save aria-hidden="true" />{t('common.save')}</Button>}
        {!isNew && !dirty && hasRole(user, 'marketer') && (status === 'draft' || status === 'paused') && <Button variant="primary" busy={action.isPending} disabled={allProblems.length > 0} onClick={() => action.mutate('activate')}><Rocket aria-hidden="true" />{t('journeys.activate')}</Button>}
        {!isNew && hasRole(user, 'marketer') && status === 'active' && <Button busy={action.isPending} onClick={() => action.mutate('pause')}><Pause aria-hidden="true" />{t('journeys.pause')}</Button>}
        {!isNew && hasRole(user, 'marketer') && status !== 'active' && <Button variant="ghost" busy={action.isPending} onClick={() => action.mutate('archive')}><Archive aria-hidden="true" />{t('journeys.archive')}</Button>}
      </header>
      {(save.error || action.error) && <div className="pe-jeditor__errors"><ErrorBanner error={save.error ?? action.error} />{fieldErrors.length > 0 && <ul className="pe-plain-list">{fieldErrors.map(([k, v]) => <li key={k} className="pe-field__error"><code><Ltr>{k}</Ltr></code>: {v}</li>)}</ul>}</div>}
      {status === 'active' && <div className="pe-jeditor__note" role="status">{t('journeys.pauseToEdit')}</div>}

      <div className="pe-jeditor__body">
        <aside className="pe-palette-panel" aria-label={t('journeys.canvas.activities')}>
          {(['messages', 'flow', 'actions'] as const).map((g) => (
            <div key={g} className="pe-palette-panel__group">
              <div className="pe-nav__label">{t(`journeys.canvas.groups.${g}`)}</div>
              {PALETTE.filter((p) => p.group === g).map((item) => (
                <button
                  key={item.key} type="button" className="pe-palette-item" disabled={!canEdit} draggable={canEdit}
                  onDragStart={(e) => { e.dataTransfer.setData('application/x-pe-journey-step', item.key); e.dataTransfer.effectAllowed = 'copy'; }}
                  onClick={() => addStep(item)}
                >
                  <span className={`pe-iconchip pe-pill--${item.tone}`} aria-hidden="true"><item.icon /></span>
                  <span>{t(`journeys.canvas.items.${item.key}`)}</span>
                  <GripVertical aria-hidden="true" className="pe-palette-item__grip" />
                </button>
              ))}
            </div>
          ))}
          <p className="pe-muted pe-palette-panel__hint">{canEdit ? t('journeys.canvas.paletteHint') : t('journeys.canvas.readOnlyHint')}</p>
        </aside>

        <JourneyCanvas
          def={def} layout={layout} templates={tpls} stats={journey.data?.stats.steps ?? {}} entered={journey.data ? journey.data.stats.enrollments.active + journey.data.stats.enrollments.completed + journey.data.stats.enrollments.exited : undefined}
          problems={allProblems} path={path} selected={selected} fitKey={`${journey.data?.id ?? 'new'}:${Object.keys(layout).length > 0}`} editable={canEdit} arrangeable={canArrange} animated={status === 'active'}
          onSelect={setSelected} onChange={(d) => { setDef(d); setPath([]); }} onLayout={onLayout} onDropItem={addStep}
        />

        <aside className="pe-inspector" aria-label={t('journeys.canvas.inspector')}>
          {selected === TRIGGER_ID ? (
            <div className="pe-stack">
              <InspectorHead icon={Zap} tone="warning" label={t('journeys.trigger')} title={t('journeys.canvas.triggerSettings')} onClose={() => setSelected(null)} />
              <TriggerEditor def={def} onChange={setDef} readOnly={!canEdit} />
            </div>
          ) : selectedStep ? (
            <div className="pe-stack">
              <InspectorHead
                icon={stepLook(selectedStep, tpls).icon} tone={stepLook(selectedStep, tpls).tone}
                label={t(`journeys.type.${selectedStep.type}`)} title={<Ltr>{selected!}</Ltr>} onClose={() => setSelected(null)}
                onDelete={canEdit ? () => { const { [selected!]: _gone, ...rest } = def.steps; const steps = Object.fromEntries(Object.entries(rest).map(([k, s]) => [k, Object.fromEntries(Object.entries(s).map(([f, v]) => [f, v === selected ? null : v])) as JourneyStep])); setDef({ ...def, start: def.start === selected ? '' : def.start, steps }); setSelected(null); } : undefined}
              />
              {problemsFor(allProblems, selected!).map((p, i) => <p key={i} className="pe-alert pe-alert--danger">{p}</p>)}
              <fieldset className="pe-step__body" disabled={!canEdit}>
                <StepBody step={selectedStep} templates={tpls} readOnly={!canEdit} onChange={(s) => setDef({ ...def, steps: { ...def.steps, [selected!]: s } })} />
              </fieldset>
              {journey.data?.stats.steps[selected!] && (
                <div className="pe-stats pe-inspector__stats">
                  {Object.entries(journey.data.stats.steps[selected!]!).map(([k, v]) => <div key={k} className="pe-stat"><strong>{v.toLocaleString()}</strong><span className="pe-muted">{t(`journeys.outcome.${k}`, { defaultValue: k })}</span></div>)}
                </div>
              )}
            </div>
          ) : (
            <div className="pe-stack">
              <div className="pe-tabs" role="tablist">
                {(['checks', 'test', 'runs'] as const).map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} className="pe-tab" onClick={() => setTab(k)}>{t(`journeys.canvas.tabs.${k}`)}</button>)}
              </div>
              {tab === 'checks' && (
                <div className="pe-stack" aria-live="polite">
                  {allProblems.length === 0 ? <p className="pe-ok">{t('journeys.noProblems')}</p> : (
                    <ul className="pe-plain-list">{allProblems.map((p, i) => <li key={i} className="pe-field__error">{p.step ? <button type="button" className="pe-linklike" onClick={() => setSelected(p.step!)}><Ltr>{p.step}</Ltr></button> : null}{p.step ? ': ' : ''}{p.message}</li>)}</ul>
                  )}
                  <p className="pe-muted">{t('journeys.canvas.checksHint')}</p>
                </div>
              )}
              {tab === 'test' && (def.start && allProblems.length === 0 ? <Simulator def={def} onPath={setPath} /> : <p className="pe-muted">{t('journeys.canvas.fixFirst')}</p>)}
              {tab === 'runs' && (!isNew && journey.data ? (
                <div className="pe-stack">
                  <div className="pe-stats">
                    {(['active', 'completed', 'exited'] as const).map((k) => <div key={k} className="pe-stat"><strong>{journey.data!.stats.enrollments[k].toLocaleString()}</strong><span className="pe-muted">{t(`journeys.runs.${k}`)}</span></div>)}
                  </div>
                  {runs.data?.data.length ? (
                    <ul className="pe-list">
                      {runs.data.data.slice(0, 20).map((r) => (
                        <li key={r.id}>
                          <div className="pe-list__main">
                            <Link to={`/contacts/${r.contact_id}`}>{displayName({ ...r, email: null })}</Link>
                            <small>{r.status === 'active' ? `${r.current_step ?? ''} · ${formatDate(r.next_run_at)}` : r.exit_reason ?? formatDate(r.completed_at)}</small>
                          </div>
                          <Badge tone={r.status === 'active' ? 'brand' : r.status === 'completed' ? 'success' : 'neutral'}>{t(`journeys.runs.${r.status}`)}</Badge>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="pe-muted">{t('journeys.runs.none')}</p>}
                </div>
              ) : <p className="pe-muted">{t('journeys.runs.none')}</p>)}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

const problemsFor = (list: { step?: string; message: string }[], step: string) => list.filter((p) => p.step === step).map((p) => p.message);
/** Only positions of nodes that still exist are saved. */
const pick = (l: Layout, def: JourneyDefinition): Layout => Object.fromEntries(Object.entries(l).filter(([k]) => k === TRIGGER_ID || def.steps[k]));

function InspectorHead({ icon: Icon, tone, label, title, onClose, onDelete }: { icon: LucideIcon; tone: Tone; label: string; title: ReactNode; onClose: () => void; onDelete?: (() => void) | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="pe-inspector__head">
      <span className={`pe-iconchip pe-pill--${tone}`} aria-hidden="true"><Icon /></span>
      <div className="pe-inspector__titles">
        <div className="pe-nav__label" style={{ padding: 0 }}>{label}</div>
        <strong>{title}</strong>
      </div>
      {onDelete && <button type="button" className="pe-icon-button" aria-label={t('journeys.removeStep')} onClick={onDelete}><Trash2 aria-hidden="true" /></button>}
      <button type="button" className="pe-icon-button" aria-label={t('common.close')} onClick={onClose}><X aria-hidden="true" /></button>
    </div>
  );
}

function TriggerEditor({ def, onChange, readOnly }: { def: JourneyDefinition; onChange: (d: JourneyDefinition) => void; readOnly: boolean }) {
  const { t } = useTranslation();
  const tr = def.trigger;
  return (
    <fieldset className="pe-stack pe-fieldset" disabled={readOnly}>
      <legend>{t('journeys.trigger')}</legend>
      <div className="pe-form-grid">
        <TextField label={t('journeys.triggerEvent')} dir="ltr" list="pe-known-events" value={tr.event_name} onChange={(e) => onChange({ ...def, trigger: { ...tr, event_name: e.target.value } })} />
        <TextField label={t('journeys.entryKey')} dir="ltr" hint={t('journeys.entryKeyHint')} value={tr.entry_key ?? ''} onChange={(e) => {
          const { entry_key: _drop, ...rest } = tr;
          onChange({ ...def, trigger: e.target.value ? { ...rest, entry_key: e.target.value } : rest });
        }} />
      </div>
      <datalist id="pe-known-events">
        {['purenet.appointment.booked', 'purenet.appointment.cancelled', 'purenet.appointment.reminder_due', 'purenet.consent.changed', 'purenet.member.updated'].map((e) => <option key={e} value={e} />)}
      </datalist>
      <div className="pe-stack">
        <strong>{t('journeys.exitWhen')}</strong>
        {def.exit_on.map((x, i) => (
          <div key={i} className="pe-rule">
            <input aria-label={t('segments.eventLabel')} dir="ltr" list="pe-known-events" value={x.event_name} onChange={(e) => onChange({ ...def, exit_on: def.exit_on.map((y, j) => (j === i ? { ...y, event_name: e.target.value } : y)) })} />
            <span className="pe-muted">{t('journeys.withSame')}</span>
            <input aria-label={t('journeys.matchProperty')} dir="ltr" placeholder="appointment_id" value={x.match_property ?? ''} onChange={(e) => onChange({ ...def, exit_on: def.exit_on.map((y, j) => {
              if (j !== i) return y;
              const { match_property: _drop, ...rest } = y;
              return e.target.value ? { ...rest, match_property: e.target.value } : rest;
            }) })} />
            {!readOnly && <Button variant="ghost" aria-label={t('segments.removeRule')} onClick={() => onChange({ ...def, exit_on: def.exit_on.filter((_, j) => j !== i) })}>×</Button>}
          </div>
        ))}
        {!readOnly && <div><Button variant="ghost" onClick={() => onChange({ ...def, exit_on: [...def.exit_on, { event_name: 'purenet.appointment.cancelled', match_property: def.trigger.entry_key ?? 'appointment_id' }] })}>+ {t('journeys.addExit')}</Button></div>}
      </div>
    </fieldset>
  );
}

function DurationInput({ value, onChange, allowNegative = false, label }: { value: Duration; onChange: (d: Duration) => void; allowNegative?: boolean; label: string }) {
  const { t } = useTranslation();
  return (
    <span className="pe-row" role="group" aria-label={label}>
      {(['days', 'hours', 'minutes'] as const).map((k) => (
        <label key={k} className="pe-row" style={{ gap: 4 }}>
          <input type="number" className="pe-narrow" min={allowNegative ? undefined : 0} value={value[k]} aria-label={`${label} ${t(`journeys.unit.${k}`)}`} onChange={(e) => onChange({ ...value, [k]: Number(e.target.value) || 0 })} />
          <span className="pe-muted">{t(`journeys.unit.${k}`)}</span>
        </label>
      ))}
    </span>
  );
}

export function StepBody({ step, templates, readOnly, onChange }: { step: JourneyStep; templates: Template[]; readOnly: boolean; onChange: (s: JourneyStep) => void }) {
  const { t } = useTranslation();
  let body;
  switch (step.type) {
    case 'send':
      body = (
        <select aria-label={t('messages.template')} value={step.template_id} onChange={(e) => onChange({ ...step, template_id: e.target.value })}>
          <option value="">{t('campaigns.choose')}</option>
          {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name} · {t(`consent.channel_${tpl.channel}`)} · {t(`consent.purpose.${tpl.purpose}`)}</option>)}
        </select>
      );
      break;
    case 'wait':
      body = <DurationInput label={t('journeys.type.wait')} value={step.duration} onChange={(d) => onChange({ ...step, duration: d })} />;
      break;
    case 'wait_until':
      body = (
        <div className="pe-stack">
          <span className="pe-row">
            <span className="pe-muted">{t('journeys.untilProperty')}</span>
            <input aria-label={t('journeys.property')} dir="ltr" className="pe-narrow-wide" value={step.property} onChange={(e) => onChange({ ...step, property: e.target.value })} />
            <span className="pe-muted">{t('journeys.plus')}</span>
          </span>
          <DurationInput label={t('journeys.offset')} allowNegative value={step.offset} onChange={(d) => onChange({ ...step, offset: d })} />
          <label className="pe-row">
            <span className="pe-muted">{t('journeys.ifPast')}</span>
            <select value={step.if_past} onChange={(e) => onChange({ ...step, if_past: e.target.value as 'continue' | 'exit' })}>
              <option value="continue">{t('journeys.ifPastContinue')}</option>
              <option value="exit">{t('journeys.ifPastExit')}</option>
            </select>
          </label>
        </div>
      );
      break;
    case 'wait_for_event':
      body = (
        <div className="pe-stack">
          <span className="pe-row">
            <input aria-label={t('segments.eventLabel')} dir="ltr" list="pe-known-events" placeholder="purenet.appointment.completed" value={step.event_name} onChange={(e) => onChange({ ...step, event_name: e.target.value })} />
            <span className="pe-muted">{t('journeys.withSame')}</span>
            <input aria-label={t('journeys.matchProperty')} dir="ltr" className="pe-narrow-wide" placeholder="appointment_id" value={step.match_property ?? ''} onChange={(e) => {
              const { match_property: _drop, ...rest } = step;
              onChange(e.target.value ? { ...rest, match_property: e.target.value } : rest);
            }} />
          </span>
          <span className="pe-row"><span className="pe-muted">{t('journeys.giveUpAfter')}</span><DurationInput label={t('journeys.timeout')} value={step.timeout} onChange={(d) => onChange({ ...step, timeout: d })} /></span>
        </div>
      );
      break;
    case 'split':
      body = <GroupEditor group={step.condition} readOnly={readOnly} onChange={(g) => onChange({ ...step, condition: g })} />;
      break;
    case 'update':
      body = <AttributesEditor value={step.attributes} readOnly={readOnly} onChange={(a) => onChange({ ...step, attributes: a })} />;
      break;
  }
  return <>{body}</>;
}

function AttributesEditor({ value, onChange, readOnly }: { value: Record<string, string | number | boolean | null>; onChange: (v: Record<string, string | number | boolean | null>) => void; readOnly: boolean }) {
  const { t } = useTranslation();
  const rows = Object.entries(value);
  const parse = (raw: string): string | number | boolean | null => (raw === 'true' ? true : raw === 'false' ? false : raw === '' ? null : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
  return (
    <div className="pe-stack">
      {rows.map(([k, v], i) => (
        <div key={i} className="pe-rule">
          <input aria-label={t('segments.attributeLabel')} dir="ltr" value={k} onChange={(e) => onChange(Object.fromEntries(rows.map(([kk, vv], j) => (j === i ? [e.target.value, vv] : [kk, vv]))))} />
          <span>=</span>
          <input aria-label={t('segments.valueLabel')} value={v === null ? '' : String(v)} onChange={(e) => onChange({ ...value, [k]: parse(e.target.value) })} />
          {!readOnly && <Button variant="ghost" aria-label={t('segments.removeRule')} onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}>×</Button>}
        </div>
      ))}
      {!readOnly && <div><Button variant="ghost" onClick={() => onChange({ ...value, [`attribute_${rows.length + 1}`]: '' })}>+ {t('journeys.addAttribute')}</Button></div>}
    </div>
  );
}

function Simulator({ def, onPath }: { def: JourneyDefinition; onPath: (steps: string[]) => void }) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const [contact, setContact] = useState<Contact | null>(null);
  const keys = useMemo(() => {
    const k = new Set<string>();
    if (def.trigger.entry_key) k.add(def.trigger.entry_key);
    for (const s of Object.values(def.steps)) if (s.type === 'wait_until') k.add(s.property);
    return [...k];
  }, [def]);
  const [context, setContext] = useState<Record<string, string>>({});
  const waitEvents = useMemo(() => [...new Set(Object.values(def.steps).flatMap((s) => (s.type === 'wait_for_event' && s.event_name ? [s.event_name] : [])))], [def]);
  const [events, setEvents] = useState<string[]>([]);
  const run = useMutation({
    mutationFn: () => api<{ path: SimulationStep[] }>('/api/journeys/simulate', { method: 'POST', body: { definition: def, contact_id: contact?.id, context, events } }),
    onSuccess: (r) => onPath(r.path.map((p) => p.step)),
  });
  return (
    <div className="pe-stack">
      <h2>{t('journeys.simulate')}</h2>
      <p className="pe-muted">{t('journeys.simulateHint')}</p>
      <ContactPicker label={t('journeys.simulateAs')} placeholder={t('campaigns.testPlaceholder')} value={contact} onChange={setContact} />
      {keys.map((k) => (
        <TextField key={k} label={k} dir="ltr" placeholder={k === 'start' ? '2026-03-10T06:00:00Z' : ''} value={context[k] ?? ''} onChange={(e) => setContext({ ...context, [k]: e.target.value })} />
      ))}
      {waitEvents.map((e) => (
        <label key={e} className="pe-row"><input type="checkbox" checked={events.includes(e)} onChange={(x) => setEvents(x.target.checked ? [...events, e] : events.filter((y) => y !== e))} /> {t('journeys.assumeEvent')} <code><Ltr>{e}</Ltr></code></label>
      ))}
      <div><Button busy={run.isPending} onClick={() => run.mutate()}>{t('journeys.runSimulation')}</Button></div>
      <ErrorBanner error={run.error} />
      {run.data && (
        <ol className="pe-timeline" data-testid="simulation">
          {run.data.path.map((p, i) => (
            <li key={i}>
              <strong>{t(`journeys.type.${p.type}`)}</strong> <small className="pe-muted"><Ltr>{p.step}</Ltr></small> → <Badge tone={p.outcome.startsWith('would_not') || p.outcome === 'exit' ? 'danger' : 'brand'}>{t(`journeys.outcome.${p.outcome}`, { defaultValue: p.outcome })}</Badge>
              <div><small className="pe-muted">{formatDate(p.at)}{p.detail?.until ? ` → ${formatDate(String(p.detail.until))}` : ''}{p.detail?.template ? ` · ${String(p.detail.template)}` : ''}{p.detail?.reason ? ` · ${t(`messages.reason.${String(p.detail.reason)}`, { defaultValue: String(p.detail.reason) })}` : ''}</small></div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

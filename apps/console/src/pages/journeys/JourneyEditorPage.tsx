import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { journeyProblems, nextSteps, type Duration, type JourneyDefinition, type JourneyStep } from '@pure-engage/shared';
import { api, ApiError } from '../../api/client.ts';
import type { Contact, JourneyDetail, JourneyRun, SimulationStep, Template } from '../../api/types.ts';
import { hasRole, useUser } from '../../auth/auth.tsx';
import { ContactPicker } from '../../components/ContactPicker.tsx';
import { Badge, Button, ErrorBanner, Ltr, Spinner, TextField, useFormatDate } from '../../components/ui.tsx';
import { GroupEditor } from '../segments/RuleBuilder.tsx';
import { displayName } from '../contacts/ContactsPage.tsx';
import { JourneyStatusBadge } from './JourneysPage.tsx';

type StepType = JourneyStep['type'];
const STEP_TYPES: StepType[] = ['send', 'wait', 'wait_until', 'wait_for_event', 'split', 'update'];
const zero: Duration = { days: 0, hours: 0, minutes: 0 };
const newId = (type: StepType) => `${type}_${Math.random().toString(36).slice(2, 6)}`;

function newStep(type: StepType, templates: Template[]): JourneyStep {
  switch (type) {
    case 'send': return { type, template_id: templates[0]?.id ?? '', next: null };
    case 'wait': return { type, duration: { ...zero, days: 1 }, next: null };
    case 'wait_until': return { type, property: 'start', offset: { ...zero, hours: -24 }, if_past: 'continue', next: null };
    case 'wait_for_event': return { type, event_name: '', timeout: { ...zero, days: 1 }, matched: null, timed_out: null };
    case 'split': return { type, condition: { type: 'group', op: 'and', rules: [] }, yes: null, no: null };
    case 'update': return { type, attributes: {}, next: null };
  }
}

/** Drops steps no longer reachable from the start (after a delete). */
function prune(def: JourneyDefinition): JourneyDefinition {
  const keep = new Set<string>();
  const walk = (id: string | null) => {
    if (!id || keep.has(id) || !def.steps[id]) return;
    keep.add(id);
    nextSteps(def.steps[id]!).forEach(walk);
  };
  walk(def.start);
  return { ...def, steps: Object.fromEntries(Object.entries(def.steps).filter(([id]) => keep.has(id))) };
}

const EMPTY: JourneyDefinition = { trigger: { event_name: 'purenet.appointment.booked' }, exit_on: [], start: '', steps: {} };

export function JourneyEditorPage() {
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

  const [name, setName] = useState('');
  const [def, setDef] = useState<JourneyDefinition>(EMPTY);
  useEffect(() => { if (journey.data) { setName(journey.data.name); setDef(journey.data.definition); } }, [journey.data]);

  const status = journey.data?.status ?? 'draft';
  const canEdit = hasRole(user, 'marketer') && (status === 'draft' || status === 'paused');
  const dirty = isNew || !journey.data || name !== journey.data.name || JSON.stringify(def) !== JSON.stringify(journey.data.definition);
  const problems = useMemo(() => (def.start ? journeyProblems(def) : [{ message: t('journeys.addFirstStep') }]), [def, t]);

  const refresh = (jid: string) => { void qc.invalidateQueries({ queryKey: ['journeys'] }); void qc.invalidateQueries({ queryKey: ['journey', jid] }); };
  const save = useMutation({
    mutationFn: () => isNew ? api<JourneyDetail>('/api/journeys', { method: 'POST', body: { name, definition: def } }) : api<JourneyDetail>(`/api/journeys/${id}`, { method: 'PUT', body: { name, definition: def } }),
    onSuccess: (j) => { refresh(j.id); if (isNew) navigate(`/journeys/${j.id}`, { replace: true }); },
  });
  const action = useMutation({
    mutationFn: (verb: 'activate' | 'pause' | 'archive') => verb === 'archive' ? api(`/api/journeys/${id}`, { method: 'DELETE' }) : api(`/api/journeys/${id}/${verb}`, { method: 'POST' }),
    onSuccess: (_r, verb) => { refresh(id!); if (verb === 'archive') navigate('/journeys'); },
  });

  const setStep = (sid: string, step: JourneyStep) => setDef({ ...def, steps: { ...def.steps, [sid]: step } });
  /** Adds a step in the empty slot that `attach` fills. */
  const addStep = (type: StepType, attach: (newStepId: string) => JourneyDefinition) => {
    const sid = newId(type);
    const base = attach(sid);
    setDef({ ...base, steps: { ...base.steps, [sid]: newStep(type, templates.data?.data ?? []) } });
  };
  const removeStep = (sid: string, detach: (replacement: string | null) => JourneyDefinition) => {
    const step = def.steps[sid]!;
    const replacement = 'next' in step ? step.next : null; // branching steps drop their branches
    setDef(prune(detach(replacement)));
  };

  if (!isNew && journey.isPending) return <div className="pe-center"><Spinner /></div>;
  if (!isNew && journey.error) return <ErrorBanner error={journey.error} />;
  const serverProblems = journey.data && !dirty ? journey.data.problems : [];
  const allProblems = [...problems, ...serverProblems.filter((p) => !problems.some((q) => q.step === p.step && q.message === p.message))];

  return (
    <section>
      <div className="pe-page-header"><Link to="/journeys" className="pe-muted">{t('journeys.backToList')}</Link></div>
      <div className="pe-page-header">
        <h1>{isNew ? t('journeys.new') : name}</h1>
        {!isNew && <JourneyStatusBadge status={status} />}
        <span className="pe-spacer" />
        {canEdit && dirty && <Button variant="primary" busy={save.isPending} disabled={!name.trim() || !def.start} onClick={() => save.mutate()}>{t('common.save')}</Button>}
        {!isNew && !dirty && hasRole(user, 'marketer') && (status === 'draft' || status === 'paused') && <Button variant="primary" busy={action.isPending} disabled={allProblems.length > 0} onClick={() => action.mutate('activate')}>{t('journeys.activate')}</Button>}
        {!isNew && hasRole(user, 'marketer') && status === 'active' && <Button busy={action.isPending} onClick={() => action.mutate('pause')}>{t('journeys.pause')}</Button>}
        {!isNew && hasRole(user, 'marketer') && status !== 'active' && <Button variant="danger" busy={action.isPending} onClick={() => action.mutate('archive')}>{t('journeys.archive')}</Button>}
      </div>
      <ErrorBanner error={save.error ?? action.error} />
      {status === 'active' && <p className="pe-muted">{t('journeys.pauseToEdit')}</p>}

      <div className="pe-grid-2 pe-grid-2--wide-first">
        <div className="pe-stack">
          <div className="pe-card pe-stack">
            <TextField label={t('templates.field.name')} value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
            <TriggerEditor def={def} onChange={setDef} readOnly={!canEdit} />
          </div>

          <div className="pe-card pe-stack" aria-label={t('journeys.steps')}>
            <h2>{t('journeys.steps')}</h2>
            <div className="pe-flow">
              <div className="pe-flow__start">{t('journeys.whenTriggered', { event: def.trigger.event_name || '…' })}</div>
              <StepTree
                id={def.start || null}
                def={def}
                templates={templates.data?.data ?? []}
                stats={journey.data?.stats.steps ?? {}}
                readOnly={!canEdit}
                setStep={setStep}
                onAdd={(type) => addStep(type, (sid) => ({ ...def, start: sid }))}
                onRemoveStart={(sid) => removeStep(sid, (rep) => ({ ...def, start: rep ?? '' }))}
                addStep={addStep}
                removeStep={removeStep}
              />
            </div>
          </div>
        </div>

        <div className="pe-stack">
          <div className="pe-card pe-stack" aria-live="polite">
            <h2>{t('journeys.checks')}</h2>
            {allProblems.length === 0 ? <p className="pe-ok">{t('journeys.noProblems')}</p> : (
              <ul className="pe-plain-list">{allProblems.map((p, i) => <li key={i} className="pe-field__error">{p.step ? <><code><Ltr>{p.step}</Ltr></code>: </> : null}{p.message}</li>)}</ul>
            )}
          </div>
          {def.start && allProblems.length === 0 && <Simulator def={def} />}
          {!isNew && journey.data && (
            <div className="pe-card pe-stack">
              <h2>{t('journeys.runs.title')}</h2>
              <div className="pe-stats">
                {(['active', 'completed', 'exited'] as const).map((k) => <div key={k} className="pe-stat"><strong>{journey.data!.stats.enrollments[k].toLocaleString()}</strong><span className="pe-muted">{t(`journeys.runs.${k}`)}</span></div>)}
              </div>
              {runs.data?.data.length ? (
                <ul className="pe-plain-list">
                  {runs.data.data.slice(0, 10).map((r) => (
                    <li key={r.id} className="pe-row">
                      <Link to={`/contacts/${r.contact_id}`}>{displayName({ ...r, email: null })}</Link>
                      <Badge tone={r.status === 'active' ? 'brand' : r.status === 'completed' ? 'success' : 'neutral'}>{t(`journeys.runs.${r.status}`)}</Badge>
                      <small className="pe-muted">{r.status === 'active' ? `${r.current_step ?? ''} · ${formatDate(r.next_run_at)}` : r.exit_reason ?? formatDate(r.completed_at)}</small>
                    </li>
                  ))}
                </ul>
              ) : <p className="pe-muted">{t('journeys.runs.none')}</p>}
            </div>
          )}
        </div>
      </div>
      {save.error instanceof ApiError && Object.keys(save.error.fieldErrors()).length > 0 && (
        <ul className="pe-plain-list">{Object.entries(save.error.fieldErrors()).map(([k, v]) => <li key={k} className="pe-field__error"><code><Ltr>{k}</Ltr></code>: {v}</li>)}</ul>
      )}
    </section>
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

interface TreeProps {
  id: string | null;
  def: JourneyDefinition;
  templates: Template[];
  stats: Record<string, Record<string, number>>;
  readOnly: boolean;
  setStep: (id: string, step: JourneyStep) => void;
  onAdd: (type: StepType) => void;
  onRemoveStart?: (id: string) => void;
  addStep: (type: StepType, attach: (newStepId: string) => JourneyDefinition) => void;
  removeStep: (id: string, detach: (replacement: string | null) => JourneyDefinition) => void;
}

/** Renders the step at `id` and everything after it; `null` renders the "add a step" slot. */
function StepTree(props: TreeProps) {
  const { id, def, readOnly, setStep, addStep, removeStep } = props;
  const { t } = useTranslation();
  if (!id) return readOnly ? <div className="pe-flow__end">{t('journeys.end')}</div> : <AddStep onAdd={props.onAdd} />;
  const step = def.steps[id];
  if (!step) return <div className="pe-field__error">{t('journeys.missingStep', { id })}</div>;

  // A child slot: points this step's `field` at the new step, which takes over what the slot led to.
  const childProps = (field: 'next' | 'yes' | 'no' | 'matched' | 'timed_out'): TreeProps => ({
    ...props,
    id: (step as Record<string, unknown>)[field] as string | null,
    // The add slot only shows where nothing follows, so the new step simply fills it.
    onAdd: (type) => addStep(type, (sid) => ({ ...def, steps: { ...def.steps, [id]: { ...step, [field]: sid } as JourneyStep } })),
    onRemoveStart: undefined,
  });

  const remove = () => {
    if (id === def.start) return props.onRemoveStart?.(id);
    const parentEntry = Object.entries(def.steps).find(([, s]) => nextSteps(s).includes(id));
    if (!parentEntry) return;
    const [pid, parent] = parentEntry;
    const field = (['next', 'yes', 'no', 'matched', 'timed_out'] as const).find((f) => (parent as Record<string, unknown>)[f] === id)!;
    removeStep(id, (rep) => ({ ...def, steps: { ...def.steps, [pid]: { ...parent, [field]: rep } as JourneyStep } }));
  };

  const branches = step.type === 'split' ? (['yes', 'no'] as const) : step.type === 'wait_for_event' ? (['matched', 'timed_out'] as const) : null;
  return (
    <>
      <StepCard id={id} step={step} templates={props.templates} stats={props.stats[id]} readOnly={readOnly} onChange={(s) => setStep(id, s)} onRemove={remove} />
      {branches ? (
        <div className="pe-flow__branches">
          {branches.map((b) => (
            <div key={b} className="pe-flow__branch">
              <div className="pe-flow__label">{t(`journeys.branch.${b}`)}</div>
              <StepTree {...childProps(b)} />
            </div>
          ))}
        </div>
      ) : <StepTree {...childProps('next')} />}
    </>
  );
}

function AddStep({ onAdd }: { onAdd: (type: StepType) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!open) return <div className="pe-flow__add"><Button variant="ghost" onClick={() => setOpen(true)}>+ {t('journeys.addStep')}</Button></div>;
  return (
    <div className="pe-flow__add pe-row">
      {STEP_TYPES.map((type) => <Button key={type} variant="ghost" onClick={() => { onAdd(type); setOpen(false); }}>{t(`journeys.type.${type}`)}</Button>)}
      <Button variant="ghost" onClick={() => setOpen(false)}>×</Button>
    </div>
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

function StepCard({ id, step, templates, stats, readOnly, onChange, onRemove }: { id: string; step: JourneyStep; templates: Template[]; stats?: Record<string, number>; readOnly: boolean; onChange: (s: JourneyStep) => void; onRemove: () => void }) {
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
  return (
    <div className="pe-step" data-step={id}>
      <div className="pe-row">
        <strong>{t(`journeys.type.${step.type}`)}</strong>
        <small className="pe-muted"><Ltr>{id}</Ltr></small>
        <span className="pe-spacer" />
        {stats && Object.entries(stats).filter(([k]) => k !== 'entered').map(([k, v]) => <Badge key={k} tone={k === 'failed' || k === 'exited' ? 'danger' : 'brand'}>{t(`journeys.outcome.${k}`, { defaultValue: k })}: {v}</Badge>)}
        {!readOnly && <Button variant="ghost" aria-label={t('journeys.removeStep')} onClick={onRemove}>×</Button>}
      </div>
      <fieldset className="pe-step__body" disabled={readOnly}>{body}</fieldset>
    </div>
  );
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

function Simulator({ def }: { def: JourneyDefinition }) {
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
  });
  return (
    <div className="pe-card pe-stack">
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

// Visual journey canvas (React Flow). The journey definition stays the single source of truth: nodes and edges are
// derived from it, and every edit on the canvas (connect, disconnect, delete) is written back to the definition.
// Node positions are presentation only and saved separately.
import { memo, useCallback, useEffect, useMemo, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, useReactFlow,
  type Connection, type Edge, type Node, type NodeChange, type NodeProps, type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import { AlertTriangle, CalendarClock, Clock, GitBranch, Hourglass, Mail, MessageSquare, UserCog, Zap, type LucideIcon } from 'lucide-react';
import { nextSteps, type Duration, type JourneyDefinition, type JourneyStep } from '@pure-engage/shared';
import type { Template } from '../../api/types.ts';
import type { Tone } from '../../components/bits.tsx';

export const TRIGGER_ID = '__trigger';
export type Layout = Record<string, { x: number; y: number }>;
export type StepType = JourneyStep['type'];
export type Field = 'next' | 'yes' | 'no' | 'matched' | 'timed_out';

const NODE_W = 248;
const NODE_H = 104;

/** Palette entries; "send" is offered twice so email and SMS read as separate activities. */
export interface PaletteItem { key: string; type: StepType; channel?: 'email' | 'sms'; icon: LucideIcon; tone: Tone; group: 'messages' | 'flow' | 'actions' }
export const PALETTE: PaletteItem[] = [
  { key: 'email', type: 'send', channel: 'email', icon: Mail, tone: 'primary', group: 'messages' },
  { key: 'sms', type: 'send', channel: 'sms', icon: MessageSquare, tone: 'sms', group: 'messages' },
  { key: 'wait', type: 'wait', icon: Clock, tone: 'info', group: 'flow' },
  { key: 'wait_until', type: 'wait_until', icon: CalendarClock, tone: 'info', group: 'flow' },
  { key: 'wait_for_event', type: 'wait_for_event', icon: Hourglass, tone: 'info', group: 'flow' },
  { key: 'split', type: 'split', icon: GitBranch, tone: 'success', group: 'flow' },
  { key: 'update', type: 'update', icon: UserCog, tone: 'muted', group: 'actions' },
];

export const outputs = (step: JourneyStep): Field[] =>
  step.type === 'split' ? ['yes', 'no'] : step.type === 'wait_for_event' ? ['matched', 'timed_out'] : ['next'];

export function stepLook(step: JourneyStep, templates: Template[]): { icon: LucideIcon; tone: Tone; channel?: 'email' | 'sms' } {
  if (step.type === 'send') {
    const ch = templates.find((t) => t.id === step.template_id)?.channel;
    return ch === 'sms' ? { icon: MessageSquare, tone: 'sms', channel: 'sms' } : { icon: Mail, tone: 'primary', channel: 'email' };
  }
  return PALETTE.find((p) => p.type === step.type) ?? PALETTE[0]!;
}

/** Positions for every node: saved ones win, the rest come from an automatic top-to-bottom layout. */
export function autoLayout(def: JourneyDefinition, saved: Layout): Layout {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 56, ranksep: 64 });
  g.setDefaultEdgeLabel(() => ({}));
  g.setNode(TRIGGER_ID, { width: NODE_W, height: 84 });
  for (const id of Object.keys(def.steps)) g.setNode(id, { width: NODE_W, height: NODE_H });
  if (def.start && def.steps[def.start]) g.setEdge(TRIGGER_ID, def.start);
  for (const [id, s] of Object.entries(def.steps)) for (const n of nextSteps(s)) if (n && def.steps[n]) g.setEdge(id, n);
  dagre.layout(g);
  const out: Layout = {};
  for (const id of [TRIGGER_ID, ...Object.keys(def.steps)]) {
    const n = g.node(id) as { x: number; y: number } | undefined;
    out[id] = saved[id] ?? { x: (n?.x ?? 0) - NODE_W / 2, y: (n?.y ?? 0) - NODE_H / 2 };
  }
  return out;
}

// ---------- nodes ----------

interface StepNodeData extends Record<string, unknown> {
  stepId: string;
  label: string;
  title: string;
  summary: string;
  icon: LucideIcon;
  tone: Tone;
  outputs: { field: Field; label: string; connected: boolean }[];
  stats: { label: string; value: number }[];
  problem?: string;
  pathIndex?: number;
  endLabel: string;
}
type StepNode = Node<StepNodeData, 'step'>;
interface TriggerNodeData extends Record<string, unknown> { label: string; title: string; summary: string; connected: boolean; endLabel: string; entered?: number }
type TriggerNode = Node<TriggerNodeData, 'trigger'>;

const handleTone: Record<Field, string> = { next: 'var(--pe-brand-600)', yes: 'var(--pe-success)', no: 'var(--pe-danger)', matched: 'var(--pe-success)', timed_out: 'var(--pe-warning)' };

const StepNodeView = memo(function StepNodeView({ data, selected }: NodeProps<StepNode>) {
  const Icon = data.icon;
  const many = data.outputs.length > 1;
  return (
    <div className="pe-jnode" data-step={data.stepId} data-selected={selected || undefined} data-problem={data.problem ? true : undefined} data-path={data.pathIndex !== undefined || undefined}>
      <Handle type="target" position={Position.Top} className="pe-jnode__handle" />
      {data.pathIndex !== undefined && <span className="pe-jnode__order" aria-hidden="true">{data.pathIndex + 1}</span>}
      <div className="pe-jnode__head">
        <span className={`pe-iconchip pe-pill--${data.tone}`} aria-hidden="true"><Icon /></span>
        <div className="pe-jnode__text">
          <div className="pe-jnode__label">{data.label}</div>
          <div className="pe-jnode__title" dir="auto">{data.title}</div>
          {data.summary && <div className="pe-jnode__summary" dir="auto">{data.summary}</div>}
        </div>
      </div>
      {data.problem && <div className="pe-jnode__problem"><AlertTriangle aria-hidden="true" />{data.problem}</div>}
      {data.stats.length > 0 && (
        <div className="pe-jnode__stats">{data.stats.map((s) => <span key={s.label}>{s.label}: {s.value.toLocaleString()}</span>)}</div>
      )}
      <div className={many ? 'pe-jnode__outs pe-jnode__outs--two' : 'pe-jnode__outs'}>
        {data.outputs.map((o) => (
          <span key={o.field} className="pe-jnode__out">
            {many && <span className="pe-jnode__outlabel" style={{ color: handleTone[o.field] }}>{o.label}</span>}
            {!o.connected && <span className="pe-jnode__end">{data.endLabel}</span>}
            <Handle id={o.field} type="source" position={Position.Bottom} className="pe-jnode__handle" style={{ background: handleTone[o.field], left: '50%' }} />
          </span>
        ))}
      </div>
    </div>
  );
});

const TriggerNodeView = memo(function TriggerNodeView({ data, selected }: NodeProps<TriggerNode>) {
  return (
    <div className="pe-jnode pe-jnode--trigger" data-step={TRIGGER_ID} data-selected={selected || undefined}>
      <div className="pe-jnode__head">
        <span className="pe-iconchip pe-pill--warning" aria-hidden="true"><Zap /></span>
        <div className="pe-jnode__text">
          <div className="pe-jnode__label">{data.label}</div>
          <div className="pe-jnode__title pe-ltr">{data.title}</div>
          {data.summary && <div className="pe-jnode__summary">{data.summary}</div>}
        </div>
      </div>
      {data.entered !== undefined && <div className="pe-jnode__stats"><span>{data.entered.toLocaleString()}</span></div>}
      <div className="pe-jnode__outs">
        <span className="pe-jnode__out">
          {!data.connected && <span className="pe-jnode__end">{data.endLabel}</span>}
          <Handle id="next" type="source" position={Position.Bottom} className="pe-jnode__handle" style={{ background: 'var(--pe-warning)', left: '50%' }} />
        </span>
      </div>
    </div>
  );
});

const nodeTypes = { step: StepNodeView, trigger: TriggerNodeView };

// ---------- canvas ----------

export interface CanvasProps {
  def: JourneyDefinition;
  layout: Layout;
  templates: Template[];
  stats: Record<string, Record<string, number>>;
  entered?: number;
  problems: { step?: string; message: string }[];
  path: string[];
  selected: string | null;
  editable: boolean;
  arrangeable: boolean;
  animated: boolean;
  /** Changes whenever the canvas should re-fit the whole journey into view (e.g. after loading). */
  fitKey: string;
  onSelect: (id: string | null) => void;
  onChange: (def: JourneyDefinition) => void;
  onLayout: (layout: Layout, persist: boolean) => void;
  onDropItem: (item: PaletteItem, at: { x: number; y: number }) => void;
}

export function summarize(step: JourneyStep, templates: Template[], t: (k: string, o?: Record<string, unknown>) => string): { title: string; summary: string } {
  const dur = (d: Duration) => (['days', 'hours', 'minutes'] as const).filter((k) => d[k]).map((k) => `${d[k]} ${t(Math.abs(d[k]) === 1 ? `journeys.unitOne.${k}` : `journeys.unit.${k}`)}`).join(' ') || `0 ${t('journeys.unit.minutes')}`;
  switch (step.type) {
    case 'send': {
      const tpl = templates.find((x) => x.id === step.template_id);
      return { title: tpl?.name ?? t('journeys.canvas.chooseTemplate'), summary: tpl ? `${t(`consent.channel_${tpl.channel}`)} · ${t(`consent.purpose.${tpl.purpose}`)}` : '' };
    }
    case 'wait': return { title: dur(step.duration), summary: '' };
    case 'wait_until': return { title: `${step.property} ${dur(step.offset).startsWith('-') ? '' : '+'}${dur(step.offset)}`, summary: t(`journeys.canvas.ifPast.${step.if_past}`) };
    case 'wait_for_event': return { title: step.event_name || '…', summary: t('journeys.canvas.timeout', { d: dur(step.timeout) }) };
    case 'split': return { title: t('journeys.canvas.conditions', { count: step.condition.rules.length }), summary: '' };
    case 'update': return { title: Object.keys(step.attributes).join(', ') || '…', summary: '' };
  }
}

export function JourneyCanvas(props: CanvasProps) {
  const { def, layout, templates, editable, arrangeable } = props;
  const { t } = useTranslation();
  const flow = useReactFlow();

  useEffect(() => {
    const id = requestAnimationFrame(() => void flow.fitView({ padding: 0.2, maxZoom: 1 }));
    return () => cancelAnimationFrame(id);
  }, [props.fitKey, flow]);

  const problemsByStep = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of props.problems) if (p.step && !m[p.step]) m[p.step] = p.message;
    return m;
  }, [props.problems]);

  const nodes = useMemo<(StepNode | TriggerNode)[]>(() => {
    const trigger: TriggerNode = {
      id: TRIGGER_ID, type: 'trigger', position: layout[TRIGGER_ID] ?? { x: 0, y: 0 }, deletable: false, selected: props.selected === TRIGGER_ID,
      data: {
        label: t('journeys.trigger'), title: def.trigger.event_name || '…', connected: !!def.start, endLabel: t('journeys.canvas.connect'),
        summary: def.trigger.entry_key ? t('journeys.canvas.onePer', { key: def.trigger.entry_key }) : '',
        ...(props.entered !== undefined ? { entered: props.entered } : {}),
      },
    };
    const steps = Object.entries(def.steps).map(([id, step]): StepNode => {
      const look = stepLook(step, templates);
      const { title, summary } = summarize(step, templates, t);
      const s = props.stats[id] ?? {};
      const pathIndex = props.path.indexOf(id);
      return {
        id, type: 'step', position: layout[id] ?? { x: 0, y: 0 }, selected: props.selected === id, deletable: editable,
        data: {
          stepId: id, label: step.type === 'send' ? t(`consent.channel_${look.channel}`) : t(`journeys.type.${step.type}`), title, summary,
          icon: look.icon, tone: look.tone, endLabel: t('journeys.end'),
          outputs: outputs(step).map((f) => ({ field: f, label: t(`journeys.branch.${f}`), connected: !!(step as Record<string, unknown>)[f] })),
          stats: Object.entries(s).filter(([k]) => k !== 'entered').map(([k, v]) => ({ label: t(`journeys.outcome.${k}`, { defaultValue: k }), value: v })),
          ...(problemsByStep[id] ? { problem: problemsByStep[id] } : {}),
          ...(pathIndex >= 0 ? { pathIndex } : {}),
        },
      };
    });
    return [trigger, ...steps];
  }, [def, layout, templates, props.stats, props.entered, props.path, props.selected, problemsByStep, editable, t]);

  const edges = useMemo<Edge[]>(() => {
    const color = (f: Field) => handleTone[f];
    const make = (source: string, field: Field, target: string): Edge => ({
      id: `${source}:${field}`, source, sourceHandle: field, target, type: 'smoothstep', animated: props.animated, deletable: editable,
      label: field === 'next' ? undefined : t(`journeys.branch.${field}`),
      style: { stroke: color(field), strokeWidth: 1.75 }, markerEnd: { type: MarkerType.ArrowClosed, color: color(field) },
      labelBgPadding: [8, 4], labelBgBorderRadius: 999, labelStyle: { fill: color(field), fontWeight: 700, fontSize: 11 },
    });
    const list: Edge[] = [];
    if (def.start && def.steps[def.start]) list.push({ ...make(TRIGGER_ID, 'next', def.start), style: { stroke: 'var(--pe-warning)', strokeWidth: 1.75 }, markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--pe-warning)' } });
    for (const [id, step] of Object.entries(def.steps)) {
      for (const f of outputs(step)) {
        const target = (step as Record<string, unknown>)[f] as string | null;
        if (target && def.steps[target]) list.push(make(id, f, target));
      }
    }
    return list;
  }, [def, props.animated, editable, t]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    let moved = false;
    let ended = false;
    const next = { ...layout };
    for (const c of changes) {
      if (c.type === 'position' && c.position) { next[c.id] = c.position; moved = true; if (c.dragging === false) ended = true; }
      if (c.type === 'select' && c.selected) props.onSelect(c.id);
    }
    if (moved && arrangeable) props.onLayout(next, ended);
  }, [layout, arrangeable, props]);

  const removeSteps = useCallback((ids: string[]) => {
    if (!editable || !ids.length) return;
    const gone = new Set(ids);
    const steps: JourneyDefinition['steps'] = {};
    for (const [id, step] of Object.entries(def.steps)) {
      if (gone.has(id)) continue;
      const copy = { ...step } as Record<string, unknown>;
      for (const f of outputs(step)) if (gone.has(copy[f] as string)) copy[f] = null;
      steps[id] = copy as JourneyStep;
    }
    props.onChange({ ...def, start: gone.has(def.start) ? '' : def.start, steps });
    props.onSelect(null);
  }, [def, editable, props]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (!editable) return;
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (!removed.length) return;
    let next = def;
    for (const eid of removed) {
      const [source, field] = eid.split(':') as [string, Field];
      if (source === TRIGGER_ID) next = { ...next, start: '' };
      else if (next.steps[source]) next = { ...next, steps: { ...next.steps, [source]: { ...next.steps[source], [field]: null } as JourneyStep } };
    }
    props.onChange(next);
  }, [def, editable, props]);

  const onConnect = useCallback((c: Connection) => {
    if (!editable || !c.source || !c.target || c.target === TRIGGER_ID || c.source === c.target) return;
    if (c.source === TRIGGER_ID) return props.onChange({ ...def, start: c.target });
    const step = def.steps[c.source];
    if (!step) return;
    const field = (c.sourceHandle ?? 'next') as Field;
    props.onChange({ ...def, steps: { ...def.steps, [c.source]: { ...step, [field]: c.target } as JourneyStep } });
  }, [def, editable, props]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const key = e.dataTransfer.getData('application/x-pe-journey-step');
    const item = PALETTE.find((p) => p.key === key);
    if (!item || !editable) return;
    const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    props.onDropItem(item, { x: at.x - NODE_W / 2, y: at.y - 30 });
  };

  return (
    <div className="pe-canvas" dir="ltr" onDragOver={(e) => { if (editable) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodesDelete={(ns) => removeSteps(ns.map((n) => n.id).filter((id) => id !== TRIGGER_ID))}
        onPaneClick={() => props.onSelect(null)}
        onNodeClick={(_, n) => props.onSelect(n.id)}
        nodesDraggable={arrangeable}
        nodesConnectable={editable}
        elementsSelectable
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
        minZoom={0.3}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--pe-border)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

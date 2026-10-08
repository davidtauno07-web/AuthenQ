import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api, qs, type ApiError } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { humanize, pct } from '../lib/format';
import { Badge, ErrorBox, Field, Loading, Modal, Pagination, Panel, StatusBadge } from '../components/ui';
import { DecisionTree, useProject, type Project } from './Projects';

export interface TaskItem {
  id: string; ordinal: number; status: string; priority: number; priorityReason: string | null; sliceValue: string | null; key: string; text: string;
  fields: Record<string, unknown>; context: Record<string, unknown>;
  finalLabels: { label: string } | null; finalSource: string | null;
  gold: { split: string; status: string } | null;
  suggestion: { id: string; label: string | null; source: string; confidence: number; rationale: string; routing: string; reviewStatus: string; ruleCited: string | null } | null;
  myLabel: { values: { label: string }; kind: string; createdAt: string } | null;
}
interface TaskDetail extends TaskItem {
  history: { id: string; values: { label: string }; source: string; kind: string; userId: string | null; createdAt: string; note: string | null }[];
  similar: { id: string; text: string; label: string | undefined; source: string | null; score: number }[];
}

const DRAFT_KEY = (pid: string) => `aq.draft.${pid}`;

export function Workspace() {
  const { project: p } = useProject();
  const [mode, setMode] = useState<'record' | 'grid'>(() => (localStorage.getItem('aq.ws.mode') as 'record' | 'grid') ?? 'record');
  useEffect(() => localStorage.setItem('aq.ws.mode', mode), [mode]);
  return (
    <div className="stack">
      <div className="row">
        <div className="tabs" style={{ marginBottom: 0, border: 'none' }} role="tablist" aria-label="Workspace mode">
          <button role="tab" aria-selected={mode === 'record'} className={mode === 'record' ? 'active' : ''} onClick={() => setMode('record')}>Record mode</button>
          <button role="tab" aria-selected={mode === 'grid'} className={mode === 'grid' ? 'active' : ''} onClick={() => setMode('grid')}>Grid mode</button>
        </div>
        <span className="right small muted">All records are synthetic. Engine suggestions are shown as prefill, never as truth.</span>
      </div>
      {mode === 'record' ? <RecordMode project={p} /> : <GridMode project={p} />}
    </div>
  );
}

function shortcutMap(p: Project) {
  const custom = p.configResolved.shortcuts ?? {};
  const keys: Record<string, string> = { submit: 'Enter', next: 'j', prev: 'k', skip: 's', flag: 'f', guide: 'g', ...custom };
  const labelKeys = new Map<string, string>();
  for (const l of p.labels) labelKeys.set((custom[`label:${l.value}`] ?? l.shortcut ?? '').toLowerCase(), l.value);
  return { keys, labelKeys };
}

function RecordMode({ project: p }: { project: Project }) {
  const toast = useToast();
  const [queue, setQueue] = useState<TaskItem[]>([]);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const startedAt = useRef(Date.now());
  const { keys, labelKeys } = useMemo(() => shortcutMap(p), [p]);
  const current = queue[index];
  const detail = useApi<TaskDetail>(current ? `/projects/${p.id}/tasks/${current.id}` : null);

  const load = useCallback(async (after?: string) => {
    try {
      const next = await api.get<TaskItem[]>(`/projects/${p.id}/tasks/next${qs({ count: 8, after })}`);
      setQueue((q) => {
        const seen = new Set(q.map((t) => t.id));
        return [...q, ...next.filter((t) => !seen.has(t.id))];
      });
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  }, [p.id]);
  useEffect(() => { load(); }, [load]);
  // Prefetch when the local queue runs low.
  useEffect(() => {
    if (queue.length && index >= queue.length - 3) load(queue[queue.length - 1]!.id);
  }, [index, queue, load]);
  // Restore draft for this task.
  useEffect(() => {
    if (!current) return;
    startedAt.current = Date.now();
    const drafts = JSON.parse(localStorage.getItem(DRAFT_KEY(p.id)) ?? '{}') as Record<string, { label: string; note: string }>;
    const d = drafts[current.id];
    setSelected(d?.label ?? current.myLabel?.values.label ?? null);
    setNote(d?.note ?? '');
  }, [current, p.id]);
  const saveDraft = (label: string | null, n: string) => {
    if (!current) return;
    const drafts = JSON.parse(localStorage.getItem(DRAFT_KEY(p.id)) ?? '{}') as Record<string, { label: string | null; note: string }>;
    drafts[current.id] = { label, note: n };
    localStorage.setItem(DRAFT_KEY(p.id), JSON.stringify(drafts));
  };
  const clearDraft = (id: string) => {
    const drafts = JSON.parse(localStorage.getItem(DRAFT_KEY(p.id)) ?? '{}') as Record<string, unknown>;
    delete drafts[id];
    localStorage.setItem(DRAFT_KEY(p.id), JSON.stringify(drafts));
  };
  const submit = useAction((v: { taskId: string; label: string; note: string }) => api.post(`/projects/${p.id}/labels`, { taskId: v.taskId, label: v.label, note: v.note || undefined, durationMs: Date.now() - startedAt.current }), {
    onSuccess: (_r, v) => {
      clearDraft(v.taskId);
      setQueue((q) => q.filter((t) => t.id !== v.taskId));
    },
    invalidate: [`/projects/${p.id}`],
  });
  const status = useAction((v: { taskId: string; action: 'skip' | 'flag' }) => api.post(`/projects/${p.id}/tasks/${v.taskId}/${v.action}`, { note: note || undefined }), {
    onSuccess: (_r, v) => {
      toast.show(v.action === 'skip' ? 'Task skipped.' : 'Task flagged for a project manager.');
      setQueue((q) => q.filter((t) => t.id !== v.taskId));
    },
  });
  const doSubmit = () => current && selected && !submit.isPending && submit.mutate({ taskId: current.id, label: selected, note });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (labelKeys.has(k)) {
        const v = labelKeys.get(k)!;
        setSelected(v);
        saveDraft(v, note);
        e.preventDefault();
      } else if (e.key === keys.submit) {
        doSubmit();
        e.preventDefault();
      } else if (k === keys.next) setIndex((i) => Math.min(queue.length - 1, i + 1));
      else if (k === keys.prev) setIndex((i) => Math.max(0, i - 1));
      else if (k === keys.skip && current) status.mutate({ taskId: current.id, action: 'skip' });
      else if (k === keys.flag && current) status.mutate({ taskId: current.id, action: 'flag' });
      else if (k === keys.guide) setShowGuide((g) => !g);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (index > 0 && index >= queue.length) setIndex(Math.max(0, queue.length - 1));
  }, [queue.length, index]);

  if (loading) return <Loading rows={6} />;
  if (error) return <ErrorBox error={error} />;
  if (!current) return <div className="empty"><h3>No open tasks</h3><p>Everything assigned to you is labeled or in review. New tasks appear when a project manager adds data or reopens tasks.</p></div>;
  const sug = current.suggestion;
  return (
    <div className="ws">
      <div className="stack">
        <div className="row small muted">
          <span>Task #{current.ordinal + 1}</span><span className="mono">{current.key}</span>
          <StatusBadge status={current.status} />
          {current.gold ? <Badge tone="outline-strong">Gold · {humanize(current.gold.split)}</Badge> : null}
          {current.sliceValue ? <Badge tone="soft">{current.sliceValue}</Badge> : null}
          <span className="right">{index + 1} of {queue.length} loaded</span>
        </div>
        <article className="record" aria-label="Record">
          {Object.entries(current.fields).map(([k, v]) => (
            <div key={k} style={{ marginBottom: 12 }}>
              <div className="field-name">{k}</div>
              <div className="pre">{String(v ?? '')}</div>
            </div>
          ))}
          {Object.keys(current.context).length ? (
            <div className="row wrap small" style={{ borderTop: 'var(--line)', paddingTop: 10 }}>
              {Object.entries(current.context).map(([k, v]) => <span key={k}><span className="muted">{k}:</span> {String(v ?? '—')}</span>)}
            </div>
          ) : null}
        </article>
        {current.priorityReason ? <p className="small muted">Prioritized: {current.priorityReason}</p> : null}
        {detail.data?.similar.length ? (
          <Panel title="Similar solved cases">
            <div className="stack" style={{ gap: 8 }}>
              {detail.data.similar.map((s) => <div key={s.id} className="small"><Badge>{s.label}</Badge> <span className="muted">({humanize(s.source)}, {pct(s.score, 0)} similar)</span><div>{s.text}</div></div>)}
            </div>
          </Panel>
        ) : null}
        {detail.data?.history.length ? (
          <Panel title="Label history">
            <table><tbody>{detail.data.history.map((h) => <tr key={h.id}><td>{h.values.label}</td><td className="small">{humanize(h.kind)} · {humanize(h.source)}</td><td className="small muted">{new Date(h.createdAt).toLocaleString()}</td></tr>)}</tbody></table>
          </Panel>
        ) : null}
      </div>
      <aside className="stack" aria-label="Labeling controls">
        {sug && sug.label ? (
          <div className="prefill small">
            <div className="row between"><strong>Engine suggestion (not truth)</strong><Badge tone="dashed">{humanize(sug.source)}</Badge></div>
            <div style={{ margin: '4px 0' }}><strong>{sug.label}</strong> · confidence {pct(sug.confidence, 0)}</div>
            <div className="muted">{sug.rationale}</div>
            <button className="sm" style={{ marginTop: 6 }} onClick={() => { setSelected(sug.label); saveDraft(sug.label, note); }}>Use as starting point</button>
          </div>
        ) : null}
        <div className="stack" style={{ gap: 6 }} role="radiogroup" aria-label="Labels">
          {p.labels.map((l) => (
            <button key={l.value} role="radio" aria-checked={selected === l.value} className={`label-btn ${selected === l.value ? 'selected' : ''}`} title={l.description} onClick={() => { setSelected(l.value); saveDraft(l.value, note); }}>
              <span>{l.value}</span><kbd>{l.shortcut}</kbd>
            </button>
          ))}
        </div>
        <Field label="Note (optional)"><textarea rows={2} value={note} onChange={(e) => { setNote(e.target.value); saveDraft(selected, e.target.value); }} /></Field>
        <button className="primary" disabled={!selected || submit.isPending} onClick={doSubmit}>Submit <kbd style={{ background: 'transparent', color: 'inherit', borderColor: 'currentColor' }}>Enter</kbd></button>
        <div className="row">
          <button className="sm" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>Previous (K)</button>
          <button className="sm" onClick={() => setIndex((i) => Math.min(queue.length - 1, i + 1))} disabled={index >= queue.length - 1}>Next (J)</button>
          <span className="right" />
          <button className="sm" onClick={() => status.mutate({ taskId: current.id, action: 'skip' })}>Skip</button>
          <button className="sm" onClick={() => status.mutate({ taskId: current.id, action: 'flag' })}>Flag</button>
        </div>
        <button className="sm ghost" onClick={() => setShowGuide((g) => !g)}>{showGuide ? 'Hide' : 'Show'} guidelines (G)</button>
        {showGuide ? (
          <Panel title={`Guideline v${p.guideline?.version ?? '—'}`}>
            <div className="stack">
              <DecisionTree node={p.guideline?.decisionTree} />
              <details><summary className="small">Full text</summary><div className="pre small" style={{ marginTop: 6 }}>{p.guideline?.content}</div></details>
            </div>
          </Panel>
        ) : null}
        <ErrorBox error={submit.error ?? status.error} />
      </aside>
    </div>
  );
}

interface View { id: string; name: string; filters: Record<string, string>; shared: boolean }
const COLS_KEY = (pid: string) => `aq.grid.cols.${pid}`;

function GridMode({ project: p }: { project: Project }) {
  const [filters, setFilters] = useState<Record<string, string>>({ status: '', label: '', source: '', slice: '', q: '', sort: 'priority' });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkLabel, setBulkLabel] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const [widths, setWidths] = useState<Record<string, number>>(() => JSON.parse(localStorage.getItem(COLS_KEY(p.id)) ?? '{}'));
  const limit = 200;
  const q = useApi<{ tasks: TaskItem[]; total: number }>(`/projects/${p.id}/tasks${qs({ ...filters, limit, offset })}`, { keepPrevious: true });
  const views = useApi<View[]>(`/projects/${p.id}/views`);
  const bulk = useAction(() => api.post<{ updated: number }>(`/projects/${p.id}/labels/bulk`, { taskIds: [...selected], label: bulkLabel }), {
    success: (r) => `Labeled ${(r as { updated?: number })?.updated ?? selected.size} tasks.`,
    invalidate: [`/projects/${p.id}`],
    onSuccess: () => setSelected(new Set()),
  });
  const delView = useAction((id: string) => api.del(`/projects/${p.id}/views/${id}`), { invalidate: [`/projects/${p.id}/views`] });
  const parentRef = useRef<HTMLDivElement>(null);
  const tasks = q.data?.tasks ?? [];
  const rv = useVirtualizer({ count: tasks.length, getScrollElement: () => parentRef.current, estimateSize: () => 38, overscan: 12 });
  const cols = [...p.textFields, ...p.contextFields];
  const startResize = (col: string, e: React.MouseEvent) => {
    const startX = e.clientX;
    const start = widths[col] ?? 280;
    const move = (ev: MouseEvent) => setWidths((w) => ({ ...w, [col]: Math.max(80, start + ev.clientX - startX) }));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setWidths((w) => { localStorage.setItem(COLS_KEY(p.id), JSON.stringify(w)); return w; });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const setF = (k: string, v: string) => { setFilters({ ...filters, [k]: v }); setOffset(0); };
  const allSelected = tasks.length > 0 && tasks.every((t) => selected.has(t.id));
  const items = rv.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = rv.getTotalSize() - (items[items.length - 1]?.end ?? 0);
  return (
    <div className="stack">
      <div className="row wrap">
        <input placeholder="Search text" aria-label="Search tasks" value={filters.q} onChange={(e) => setF('q', e.target.value)} style={{ width: 220 }} />
        <select aria-label="Status" value={filters.status} onChange={(e) => setF('status', e.target.value)} style={{ width: 150 }}><option value="">All statuses</option>{['OPEN', 'LABELED', 'IN_REVIEW', 'DONE', 'SKIPPED', 'FLAGGED'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
        <select aria-label="Label" value={filters.label} onChange={(e) => setF('label', e.target.value)} style={{ width: 160 }}><option value="">All labels</option>{p.labels.map((l) => <option key={l.value}>{l.value}</option>)}</select>
        <select aria-label="Label source" value={filters.source} onChange={(e) => setF('source', e.target.value)} style={{ width: 150 }}><option value="">All sources</option>{['HUMAN', 'REVIEW', 'ENGINE', 'GOLD', 'ADJUDICATED'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
        <select aria-label="Sort" value={filters.sort} onChange={(e) => setF('sort', e.target.value)} style={{ width: 170 }}><option value="priority">Priority (active learning)</option><option value="ordinal">Original order</option><option value="confidence">Lowest confidence</option><option value="updated">Recently updated</option></select>
        <select aria-label="Saved views" value="" onChange={(e) => { const v = views.data?.find((x) => x.id === e.target.value); if (v) { setFilters({ ...filters, ...v.filters }); setOffset(0); } }} style={{ width: 170 }}>
          <option value="">Saved views…</option>
          {(views.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}{v.shared ? ' (shared)' : ''}</option>)}
        </select>
        <button className="sm" onClick={() => setSaveOpen(true)}>Save view</button>
        {views.data?.length ? <details className="small"><summary>Manage views</summary>{views.data.map((v) => <div key={v.id} className="row">{v.name}<button className="sm ghost" onClick={() => delView.mutate(v.id)}>Delete</button></div>)}</details> : null}
      </div>
      {selected.size ? (
        <div className="callout row">
          <strong>{selected.size} selected</strong>
          <select aria-label="Bulk label" value={bulkLabel} onChange={(e) => setBulkLabel(e.target.value)} style={{ width: 200 }}><option value="">Choose label…</option>{p.labels.map((l) => <option key={l.value}>{l.value}</option>)}</select>
          <button className="primary sm" disabled={!bulkLabel || bulk.isPending} onClick={() => bulk.mutate(undefined)}>Apply label</button>
          <button className="sm ghost" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      ) : null}
      {q.error ? <ErrorBox error={q.error} /> : null}
      <div ref={parentRef} className="table-wrap grid-ws" style={{ height: 560 }}>
        <table style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
          <thead>
            <tr>
              <th className="frozen" style={{ width: 150 }}><label className="check"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(tasks.map((t) => t.id)))} /> Task</label></th>
              {cols.map((c) => <th key={c} style={{ width: widths[c] ?? (p.textFields.includes(c) ? 380 : 140) }}>{c}<span className="resizer" role="separator" aria-label={`Resize ${c}`} onMouseDown={(e) => startResize(c, e)} /></th>)}
              <th style={{ width: 130 }}>Status</th><th style={{ width: 160 }}>Label</th><th style={{ width: 200 }}>Engine</th><th style={{ width: 90 }}>Priority</th>
            </tr>
          </thead>
          <tbody>
            {padTop > 0 ? <tr style={{ height: padTop }}><td colSpan={cols.length + 5} style={{ padding: 0, border: 'none' }} /></tr> : null}
            {items.map((vi) => {
              const t = tasks[vi.index]!;
              return (
                <tr key={t.id} className={selected.has(t.id) ? 'selected' : ''} style={{ height: 38 }}>
                  <td className="frozen"><label className="check"><input type="checkbox" aria-label={`Select task ${t.ordinal + 1}`} checked={selected.has(t.id)} onChange={() => { const s = new Set(selected); if (s.has(t.id)) s.delete(t.id); else s.add(t.id); setSelected(s); }} /> <span className="mono small">{t.key}</span></label></td>
                  {cols.map((c) => <td key={c} className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String((p.textFields.includes(c) ? t.fields[c] : t.context[c]) ?? '')}>{String((p.textFields.includes(c) ? t.fields[c] : t.context[c]) ?? '')}</td>)}
                  <td><StatusBadge status={t.status} /></td>
                  <td>{t.finalLabels ? <><strong>{t.finalLabels.label}</strong> <span className="small muted">{humanize(t.finalSource)}</span></> : '—'}</td>
                  <td className="small">{t.suggestion?.label ? <span className="muted">{t.suggestion.label} · {pct(t.suggestion.confidence, 0)}</span> : '—'}</td>
                  <td className="small" title={t.priorityReason ?? ''}>{t.priority.toFixed(2)}</td>
                </tr>
              );
            })}
            {padBottom > 0 ? <tr style={{ height: padBottom }}><td colSpan={cols.length + 5} style={{ padding: 0, border: 'none' }} /></tr> : null}
          </tbody>
        </table>
      </div>
      <Pagination total={q.data?.total ?? 0} limit={limit} offset={offset} onChange={setOffset} />
      {saveOpen ? <SaveView projectId={p.id} filters={filters} onClose={() => setSaveOpen(false)} /> : null}
    </div>
  );
}

function SaveView({ projectId, filters, onClose }: { projectId: string; filters: Record<string, string>; onClose: () => void }) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const save = useAction(() => api.post(`/projects/${projectId}/views`, { name, filters, shared }), { success: 'View saved.', invalidate: [`/projects/${projectId}/views`], onSuccess: onClose });
  return (
    <Modal title="Save view" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!name.trim()} onClick={() => save.mutate(undefined)}>Save</button></>}>
      <div className="stack">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with project members</label>
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { validateFields } from '@demo/dsl';
import { api, ApiError, type InboxItem, type RunSummary, type SavedFlowSummary, type ServerConfig } from '../api';
import { defaultsFor, FormFields } from './FormFields';
import { Icon } from './icons';
import { HumanTask } from './RunView';

const NO_KEY = 'Add ANTHROPIC_API_KEY to .env and restart the worker and API to run workflows.';

/** Run `fn` now and every `ms` until unmounted. Returns a manual refresh. */
function usePoll(fn: () => Promise<void> | void, ms: number, deps: unknown[]) {
  const run = useCallback(fn, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        await run();
      } finally {
        if (!stop) timer = setTimeout(tick, ms);
      }
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [run, ms]);
  return run;
}

/**
 * Operator view: pick a saved flow, fill in its inputs, start it, and answer
 * any approvals that are waiting, without touching the builder.
 */
export function Execute({
  flowId,
  onSelectFlow,
  onOpenRun,
  flowsVersion,
}: {
  flowId?: string;
  onSelectFlow: (id: string) => void;
  onOpenRun: (runId: string) => void;
  /** Bumped when the builder saves or deletes, to refresh the list. */
  flowsVersion: number;
}) {
  const [flows, setFlows] = useState<SavedFlowSummary[] | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Load the flow list, retrying while the API is unreachable (e.g. still starting).
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api
        .listFlows()
        .then((r) => {
          if (stop) return;
          setFlows(r.flows);
          setError(null);
        })
        .catch((e) => {
          if (stop) return;
          setError(`Can’t load flows: ${(e as Error).message}. Retrying…`);
          timer = setTimeout(load, 3000);
        });
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [flowsVersion]);

  const refreshInbox = usePoll(
    async () => {
      try {
        setInbox((await api.inbox()).items);
      } catch {
        /* keep the last list */
      }
    },
    2000,
    [],
  );

  const runnable = flows?.filter((f) => f.valid) ?? [];
  const selected = flows?.find((f) => f.id === flowId) ?? runnable[0];

  return (
    <div className="execute">
      <aside className="exec-flows">
        <div className="exec-title">Flows</div>
        {error && <div className="error-box">{error}</div>}
        {flows && flows.length === 0 && <div className="muted small">No saved flows yet. Build one and press Save.</div>}
        {flows?.map((f) => (
          <button
            key={f.id}
            className={`flow-card ${selected?.id === f.id ? 'on' : ''}`}
            onClick={() => onSelectFlow(f.id)}
            disabled={!f.valid}
            title={f.valid ? '' : 'This flow has errors. Fix it in the builder.'}
          >
            <span className="flow-card-name">{f.name}</span>
            <span className="flow-card-desc">{f.description || <em>No description</em>}</span>
            <span className="flow-card-meta">
              v{f.version} · updated {timeAgo(f.updatedAt)}
              {!f.valid && <span className="chip warn-chip">{f.errorCount} error{f.errorCount === 1 ? '' : 's'}</span>}
            </span>
          </button>
        ))}
      </aside>

      <section className="exec-main">
        {selected ? <Launcher key={selected.id} flow={selected} onOpenRun={onOpenRun} onStarted={refreshInbox} /> : flows && <div className="muted">Pick a flow to run.</div>}
      </section>

      <aside className="exec-inbox">
        <div className="exec-title">
          Approvals {inbox.length > 0 && <span className="count">{inbox.length}</span>}
        </div>
        {inbox.length === 0 && <div className="inbox-empty">Nothing is waiting for a person. Requests from any running flow show up here.</div>}
        {inbox.map((item) => (
          <HumanTask
            key={`${item.runId}:${item.request.nodeId}:${item.request.requestedAt}`}
            runId={item.runId}
            req={item.request}
            nodeLabel={item.nodeLabel}
            onSubmitted={refreshInbox}
            context={
              <div className="inbox-context small">
                <b>{item.flowName}</b> ·{' '}
                <button className="linkish mono" onClick={() => onOpenRun(item.runId)}>
                  {item.runId}
                </button>{' '}
                · asked {timeAgo(new Date(item.request.requestedAt).toISOString())}
              </div>
            }
          />
        ))}
      </aside>
    </div>
  );
}

function Launcher({ flow, onOpenRun, onStarted }: { flow: SavedFlowSummary; onOpenRun: (id: string) => void; onStarted: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => defaultsFor(flow.inputs));
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [justStarted, setJustStarted] = useState<string | null>(null);

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setError('Can’t reach the API server on :3001.'));
  }, []);

  const refreshRuns = usePoll(
    async () => {
      try {
        setRuns((await api.listRuns(flow.id)).runs);
      } catch {
        /* keep the last list */
      }
    },
    2000,
    [flow.id],
  );

  const start = async () => {
    const errs = validateFields(flow.inputs, values);
    if (errs.length) return setError(errs.join('; '));
    setBusy(true);
    setError(null);
    try {
      const { runId } = await api.startSavedRun(flow.id, values);
      setJustStarted(runId);
      refreshRuns();
      // The first approval usually appears a few seconds in.
      setTimeout(onStarted, 1500);
    } catch (e) {
      const err = e as ApiError;
      setError([err.message, ...(err.issues ?? []).map((i) => i.message)].join(' · '));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="launch card">
        <div className="launch-head">
          <div>
            <div className="launch-name">{flow.name}</div>
            {flow.description && <div className="muted">{flow.description}</div>}
          </div>
          <span className="chip ghost">v{flow.version}</span>
        </div>
        {Object.keys(flow.inputs).length ? (
          <FormFields fields={flow.inputs} values={values} onChange={setValues} />
        ) : (
          <div className="muted small">This flow has no inputs.</div>
        )}
        <div className="launch-foot">
          <span className="muted small">{config ? (config.claudeAvailable ? `Runs on ${config.model}` : NO_KEY) : ''}</span>
          <button className="btn primary" onClick={start} disabled={busy || !config?.claudeAvailable}>
            <Icon name="play" /> {busy ? 'Starting…' : 'Run'}
          </button>
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>

      <div className="exec-title">Recent runs of this flow</div>
      {runs.length === 0 && <div className="muted small">No runs yet.</div>}
      <ul className="run-list">
        {runs.map((r) => (
          <li key={r.runId} className={r.runId === justStarted ? 'fresh' : ''}>
            <button className="run-row" onClick={() => onOpenRun(r.runId)}>
              <RunPill run={r} />
              <span className="run-row-main">
                <span className="mono small">{r.runId}</span>
                <span className="muted small">
                  {r.status === 'RUNNING' && r.currentNode ? `at ${r.currentNode} · ` : ''}started {timeAgo(r.startTime)}
                </span>
              </span>
              <span className="muted small">View →</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function RunPill({ run }: { run: RunSummary }) {
  if (run.status === 'RUNNING') {
    const s = run.runStatus ?? 'running';
    const label = s === 'waiting_human' ? 'Waiting for input' : s === 'waiting_timer' ? 'Timer' : 'Running';
    return <span className={`pill s-${s}`}>{label}</span>;
  }
  return <span className={`pill t-${run.status.toLowerCase()}`}>{run.status.toLowerCase()}</span>;
}

function timeAgo(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

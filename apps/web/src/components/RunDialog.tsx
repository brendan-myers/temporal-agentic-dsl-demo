import { useEffect, useState } from 'react';
import { validateFields, type WorkflowDefinition } from '@demo/dsl';
import { api, ApiError, type ServerConfig } from '../api';
import { defaultsFor, FormFields } from './FormFields';
import { Icon } from './icons';

const NO_KEY = 'Add ANTHROPIC_API_KEY to .env and restart the worker and API to run workflows.';

export function RunDialog({
  definition,
  onClose,
  onStarted,
}: {
  definition: WorkflowDefinition;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => defaultsFor(definition.inputs));
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setError('Can’t reach the API server on :3001. Is `pnpm dev` running?'));
  }, []);

  const start = async () => {
    const errs = validateFields(definition.inputs, values);
    if (errs.length) return setError(errs.join('; '));
    setBusy(true);
    setError(null);
    try {
      const { runId } = await api.startRun(definition, values);
      onStarted(runId);
    } catch (e) {
      const err = e as ApiError;
      setError([err.message, ...(err.issues ?? []).map((i) => i.message)].join(' · '));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Start a run">
        <div className="modal-head">
          <div>
            <div className="modal-title">Run “{definition.name}”</div>
            <div className="muted small">Starts a Temporal workflow with this JSON and these inputs.</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {Object.keys(definition.inputs).length ? (
            <FormFields fields={definition.inputs} values={values} onChange={setValues} />
          ) : (
            <div className="muted small">This workflow has no inputs.</div>
          )}
          {config && (
            <div className="muted small">
              {config.claudeAvailable ? `Runs on ${config.model}, with this JSON and these inputs as its context.` : NO_KEY}
            </div>
          )}
          {error && <div className="error-box">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={start} disabled={busy || !config?.claudeAvailable}>
            <Icon name="play" /> {busy ? 'Starting…' : 'Start run'}
          </button>
        </div>
      </div>
    </div>
  );
}

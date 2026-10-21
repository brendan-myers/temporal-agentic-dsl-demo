import { useEffect, useState } from 'react';
import { api, type RunSummary } from '../api';

export function RunsList({ onOpen }: { onOpen: (id: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      api
        .listRuns()
        .then((r) => !stop && (setRuns(r.runs), setError(null)))
        .catch((e) => !stop && setError((e as Error).message));
    load();
    const t = setInterval(load, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="runs-page">
      <h2>Runs</h2>
      {error && <div className="error-box">{error}</div>}
      {runs && runs.length === 0 && <div className="muted">No runs yet. Build a workflow and press Run.</div>}
      {runs && runs.length > 0 && (
        <div className="table-wrap">
          <table className="runs">
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Run ID</th>
                <th>Model</th>
                <th>Status</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId} onClick={() => onOpen(r.runId)}>
                  <td>{r.name}</td>
                  <td className="mono small">{r.runId}</td>
                  <td className="small">{r.model ?? '—'}</td>
                  <td>
                    <span className={`pill t-${r.status.toLowerCase()}`}>{r.status.toLowerCase()}</span>
                  </td>
                  <td className="small">{new Date(r.startTime).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

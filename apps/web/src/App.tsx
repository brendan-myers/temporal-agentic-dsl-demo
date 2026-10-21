import { useEffect, useState } from 'react';
import { api } from './api';
import { Builder } from './components/Builder';
import { Execute } from './components/Execute';
import { RunsList } from './components/RunsList';
import { RunView } from './components/RunView';

type Route = { page: 'build' } | { page: 'execute'; flowId?: string } | { page: 'runs' } | { page: 'run'; id: string };

function parse(hash: string): Route {
  const run = hash.match(/^#\/runs\/(.+)$/);
  if (run) return { page: 'run', id: decodeURIComponent(run[1]) };
  if (hash === '#/runs') return { page: 'runs' };
  const exec = hash.match(/^#\/execute(?:\/(.+))?$/);
  if (exec) return { page: 'execute', flowId: exec[1] ? decodeURIComponent(exec[1]) : undefined };
  return { page: 'build' };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  const [flowsVersion, setFlowsVersion] = useState(0);
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // Approvals count for the nav, so waiting requests are visible from any page.
  useEffect(() => {
    let stop = false;
    const tick = () =>
      api
        .inbox()
        .then((r) => !stop && setWaiting(r.items.length))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const go = (hash: string) => (location.hash = hash);
  const openRun = (id: string) => go(`#/runs/${encodeURIComponent(id)}`);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          Agent Workflow Builder
          <span className="brand-sub">JSON DSL → generic Temporal agent</span>
        </div>
        <nav>
          <a className={route.page === 'build' ? 'on' : ''} href="#/build">
            Build
          </a>
          <a className={route.page === 'execute' ? 'on' : ''} href="#/execute">
            Execute
            {waiting > 0 && (
              <span className="count" title={`${waiting} waiting for a person`}>
                {waiting}
              </span>
            )}
          </a>
          <a className={route.page === 'runs' || route.page === 'run' ? 'on' : ''} href="#/runs">
            Runs
          </a>
        </nav>
      </header>
      <main>
        {/* Builder stays mounted so canvas state survives tab switches. */}
        <div hidden={route.page !== 'build'} className="page">
          <Builder onRunStarted={openRun} onFlowsChanged={() => setFlowsVersion((v) => v + 1)} />
        </div>
        {route.page === 'execute' && (
          <Execute
            flowId={route.flowId}
            onSelectFlow={(id) => go(`#/execute/${encodeURIComponent(id)}`)}
            onOpenRun={openRun}
            flowsVersion={flowsVersion}
          />
        )}
        {route.page === 'runs' && <RunsList onOpen={openRun} />}
        {route.page === 'run' && <RunView key={route.id} runId={route.id} onBack={() => history.back()} />}
      </main>
    </div>
  );
}

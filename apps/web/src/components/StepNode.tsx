import { Handle, Position, type NodeProps } from '@xyflow/react';
import { TOOLS_BY_NAME } from '@demo/dsl';
import type { StepData, StepNode as StepNodeType } from '../flow';
import { Icon, NODE_META } from './icons';

function clip(s: string | undefined, n = 90) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function Summary({ step }: { step: StepData }) {
  switch (step.type) {
    case 'start':
      return <div className="step-sub">Run begins with its inputs</div>;
    case 'agent':
      return (
        <>
          <div className="step-sub">{clip(step.instructions) || <em>No instructions yet</em>}</div>
          {step.tools.length > 0 && (
            <div className="chips">
              {step.tools.map((t) => (
                <span key={t} className="chip">{t}</span>
              ))}
            </div>
          )}
        </>
      );
    case 'tool': {
      const spec = TOOLS_BY_NAME[step.tool];
      return (
        <>
          <div className="step-sub mono">{step.tool}</div>
          <div className="step-sub">
            {step.args === 'agent'
              ? 'Agent fills the arguments'
              : Object.entries(step.args)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(', ')}
          </div>
          {!spec && <div className="step-sub warn">Unknown tool</div>}
        </>
      );
    }
    case 'decision':
      return <div className="step-sub">{clip(step.instructions) || <em>No criteria yet</em>}</div>;
    case 'human':
      return (
        <>
          <div className="step-sub">{clip(step.prompt, 80)}</div>
          <div className="chips">
            {step.assignee && <span className="chip">{step.assignee}</span>}
            {step.timeout && <span className="chip">⏱ {step.timeout}</span>}
            {Object.keys(step.form).map((f) => (
              <span key={f} className="chip ghost">{f}</span>
            ))}
          </div>
        </>
      );
    case 'wait':
      return (
        <div className="step-sub">
          {/^\{\{/.test(step.duration) ? (
            <>
              Pause for <span className="mono">{step.duration.replace(/[{}\s]/g, '')}</span>
            </>
          ) : (
            `Pause for ${step.duration}`
          )}
        </div>
      );
    case 'end':
      return (
        <div className="chips">
          {Object.keys(step.output).map((f) => (
            <span key={f} className="chip ghost">{f}</span>
          ))}
        </div>
      );
  }
}

export function StepNode({ id, data, selected }: NodeProps<StepNodeType>) {
  const { step, run, visits, issue } = data;
  const cls = ['step', `t-${step.type}`, selected && 'selected', run && `run-${run}`, issue && `issue-${issue}`]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls}>
      {step.type !== 'start' && <Handle type="target" position={Position.Top} />}
      <div className="step-head">
        <span className="step-icon">
          <Icon name={step.type} size={13} />
        </span>
        <span className="step-kind">{NODE_META[step.type].title}</span>
        {visits && visits > 1 ? <span className="step-visits">×{visits}</span> : null}
        <span className="step-id">{id}</span>
      </div>
      <div className="step-title">{step.label || NODE_META[step.type].title}</div>
      <Summary step={step} />
      {run === 'waiting' && <div className="step-status">Waiting…</div>}
      {step.type !== 'end' && <Handle type="source" position={Position.Bottom} />}
      {step.type === 'human' && (
        <Handle type="source" id="timeout" position={Position.Right} className="handle-timeout" title="Timeout path: drag from here" />
      )}
    </div>
  );
}

export const nodeTypes = { step: StepNode };

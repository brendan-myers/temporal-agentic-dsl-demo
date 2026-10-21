import type { NodeType } from '@demo/dsl';

const paths: Record<NodeType | 'run' | 'play' | 'copy' | 'download' | 'upload' | 'trash' | 'external' | 'check' | 'alert', string> = {
  start: 'M8 5.5v13l10-6.5z',
  agent: 'M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z',
  tool: 'M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7V20h3.3l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.4 2.4-2.6-.6-.6-2.6z',
  decision: 'M12 3l9 9-9 9-9-9z',
  human: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0z',
  wait: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm1 4h-2v6l5 3 1-1.7-4-2.3z',
  end: 'M6 6h12v12H6z',
  run: 'M8 5.5v13l10-6.5z',
  play: 'M8 5.5v13l10-6.5z',
  copy: 'M8 8V4h12v12h-4M4 8h12v12H4z',
  download: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14',
  upload: 'M12 20V9m0 0l-4 4m4-4l4 4M5 4h14',
  trash: 'M5 7h14M10 7V4h4v3m-7 0l1 13h8l1-13',
  external: 'M14 4h6v6m0-6L10 14M18 14v6H4V6h6',
  check: 'M5 12l5 5 9-10',
  alert: 'M12 4l9 16H3zm0 6v4m0 3v.5',
};

const stroked = new Set(['copy', 'download', 'upload', 'trash', 'external', 'check', 'alert']);

export function Icon({ name, size = 14 }: { name: keyof typeof paths; size?: number }) {
  const s = stroked.has(name);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="icon">
      <path
        d={paths[name]}
        fill={s ? 'none' : 'currentColor'}
        stroke={s ? 'currentColor' : 'none'}
        strokeWidth={s ? 2 : 0}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const NODE_META: Record<NodeType, { title: string; blurb: string }> = {
  start: { title: 'Start', blurb: 'Where the run begins' },
  agent: { title: 'Agent step', blurb: 'LLM task with instructions and tools' },
  tool: { title: 'Tool call', blurb: 'Call one tool, save the result' },
  decision: { title: 'Decision', blurb: 'Agent picks one labelled branch' },
  human: { title: 'Human input', blurb: 'Durable wait for approval or a form' },
  wait: { title: 'Wait', blurb: 'Durable timer' },
  end: { title: 'End', blurb: 'Finish with structured output' },
};

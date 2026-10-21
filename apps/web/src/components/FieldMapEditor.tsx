import { useState } from 'react';
import type { FieldDef, FieldMap, FieldType } from '@demo/dsl';
import { Icon } from './icons';

const TYPES: FieldType[] = ['string', 'text', 'number', 'boolean', 'duration'];

/** Edit a flat field map: run inputs, human forms, end outputs. */
export function FieldMapEditor({
  value,
  onChange,
  withDefaults = false,
  addLabel = 'Add field',
}: {
  value: FieldMap;
  onChange: (next: FieldMap) => void;
  withDefaults?: boolean;
  addLabel?: string;
}) {
  const [draft, setDraft] = useState('');
  const entries = Object.entries(value);

  const update = (name: string, patch: Partial<FieldDef>) => onChange({ ...value, [name]: { ...value[name], ...patch } });
  const rename = (from: string, to: string) => {
    const clean = to.trim().replace(/\W+/g, '_');
    if (!clean || clean === from || value[clean]) return;
    onChange(Object.fromEntries(entries.map(([k, f]) => (k === from ? [clean, f] : [k, f]))));
  };
  const remove = (name: string) => onChange(Object.fromEntries(entries.filter(([k]) => k !== name)));
  const add = () => {
    const name = draft.trim().replace(/\W+/g, '_');
    if (!name || value[name]) return;
    onChange({ ...value, [name]: { type: 'string' } });
    setDraft('');
  };

  return (
    <div className="fields">
      {entries.length === 0 && <div className="muted small">No fields yet.</div>}
      {entries.map(([name, f]) => (
        <div key={name} className="field-row">
          <div className="field-row-main">
            <input className="mono" defaultValue={name} onBlur={(e) => rename(name, e.target.value)} aria-label="Field name" />
            <select value={f.type} onChange={(e) => update(name, { type: e.target.value as FieldType, default: undefined })} aria-label="Field type">
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <label className="check" title="Required">
              <input type="checkbox" checked={!!f.required} onChange={(e) => update(name, { required: e.target.checked || undefined })} />
              req
            </label>
            <button className="icon-btn" onClick={() => remove(name)} title="Remove field">
              <Icon name="trash" />
            </button>
          </div>
          <input
            className="small"
            placeholder="Description (optional)"
            value={f.description ?? ''}
            onChange={(e) => update(name, { description: e.target.value || undefined })}
          />
          {withDefaults && f.type !== 'boolean' && (
            <input
              className="small"
              placeholder={f.type === 'duration' ? 'Default for test runs, e.g. 10m' : 'Default value for test runs'}
              value={f.default === undefined ? '' : String(f.default)}
              onChange={(e) =>
                update(name, {
                  default: e.target.value === '' ? undefined : f.type === 'number' ? Number(e.target.value) : e.target.value,
                })
              }
            />
          )}
        </div>
      ))}
      <div className="field-add">
        <input
          placeholder="new_field"
          className="mono"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn small" onClick={add} disabled={!draft.trim()}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}

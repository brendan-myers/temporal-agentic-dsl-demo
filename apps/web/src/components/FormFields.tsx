import { useState } from 'react';
import type { FieldMap } from '@demo/dsl';

/** Render inputs for a field map (run inputs and human forms). */
export function FormFields({
  fields,
  values,
  onChange,
}: {
  fields: FieldMap;
  values: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const set = (k: string, v: unknown) => onChange({ ...values, [k]: v });
  return (
    <div className="form-fields">
      {Object.entries(fields).map(([name, f]) => (
        <label key={name} className="form-field">
          <span className="form-label">
            <span className="mono">{name}</span>
            {f.required && <span className="req">*</span>}
            {f.description && <span className="muted"> · {f.description}</span>}
          </span>
          {f.type === 'boolean' ? (
            <div className="seg">
              <button type="button" className={values[name] === true ? 'on yes' : ''} onClick={() => set(name, true)}>
                Yes
              </button>
              <button type="button" className={values[name] === false ? 'on no' : ''} onClick={() => set(name, false)}>
                No
              </button>
            </div>
          ) : f.type === 'duration' ? (
            <DurationInput value={values[name] as string | undefined} onChange={(v) => set(name, v)} />
          ) : f.type === 'text' ? (
            <textarea rows={3} value={(values[name] as string) ?? ''} onChange={(e) => set(name, e.target.value)} />
          ) : f.type === 'number' ? (
            <input
              type="number"
              value={values[name] === undefined ? '' : String(values[name])}
              onChange={(e) => set(name, e.target.value === '' ? undefined : Number(e.target.value))}
            />
          ) : (
            <input value={(values[name] as string) ?? ''} onChange={(e) => set(name, e.target.value)} />
          )}
        </label>
      ))}
    </div>
  );
}

const UNITS = [
  ['s', 'seconds'],
  ['m', 'minutes'],
  ['h', 'hours'],
  ['d', 'days'],
] as const;

/** Number + unit, stored as a duration string like "15m". */
function DurationInput({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  const m = /^(\d+)([smhd])$/.exec(value ?? '');
  const [unit, setUnit] = useState<string>(m?.[2] ?? 'm');
  const amount = m?.[1] ?? '';
  return (
    <div className="duration-input">
      <input
        type="number"
        min={0}
        step={1}
        value={amount}
        placeholder="e.g. 15"
        onChange={(e) => onChange(e.target.value === '' ? undefined : `${Math.max(0, Math.round(Number(e.target.value)))}${unit}`)}
      />
      <select
        value={unit}
        onChange={(e) => {
          setUnit(e.target.value);
          if (amount) onChange(`${amount}${e.target.value}`);
        }}
      >
        {UNITS.map(([u, label]) => (
          <option key={u} value={u}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function defaultsFor(fields: FieldMap): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).flatMap(([k, f]) => (f.default !== undefined ? [[k, f.default]] : [])));
}

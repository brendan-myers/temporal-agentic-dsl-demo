import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXAMPLES, refundTriage, incidentResponse } from '../../../apps/web/src/examples';
import { buildAgentTools, compileFirstMessage } from './compile';

const AGENT_SYSTEM_PROMPT = readFileSync(join(__dirname, '../../../apps/worker/agent/system-prompt.md'), 'utf8');
import { renderTemplate } from './graph';
import { validateDefinition, validateFields } from './validate';

test('bundled examples are valid', () => {
  for (const ex of EXAMPLES) {
    const r = validateDefinition(ex);
    assert.ok(r.ok, `${ex.id}: ${r.issues.map((i) => i.message).join('; ')}`);
  }
});

test('structural errors are reported', () => {
  const broken = structuredClone(refundTriage);
  broken.edges = broken.edges.filter((e) => e.id !== 'e5'); // decision left with one option
  broken.edges.push({ id: 'bad', from: 'reply', to: 'nowhere' });
  broken.nodes.push({ id: 'orphan', type: 'wait', duration: 'soon' } as never);
  const r = validateDefinition(broken);
  assert.equal(r.ok, false);
  const msgs = r.issues.map((i) => i.message).join('\n');
  // A bad duration fails the schema before graph checks run.
  assert.match(msgs, /duration/);

  broken.nodes = broken.nodes.filter((n) => n.id !== 'orphan');
  const r2 = validateDefinition(broken);
  const msgs2 = r2.issues.map((i) => i.message).join('\n');
  assert.match(msgs2, /needs at least 2 options/);
  assert.match(msgs2, /unknown node "nowhere"/);
});

test('field validation', () => {
  assert.deepEqual(validateFields({ a: { type: 'string', required: true } }, {}), ['"a" is required']);
  assert.deepEqual(validateFields({ n: { type: 'number' } }, { n: 'x' }), ['"n" must be a number']);
  assert.deepEqual(validateFields({ b: { type: 'boolean', required: true } }, { b: false }), []);
});

test('templates resolve and leave unknowns visible', () => {
  const out = renderTemplate('{{inputs.id}} costs {{order.amount}} ({{missing.x}})', { inputs: { id: 'A1' }, order: { amount: 12.5 } });
  assert.equal(out, 'A1 costs 12.5 ({{missing.x}})');
});

test('agent context: fixed system prompt, JSON passed verbatim', () => {
  assert.doesNotMatch(AGENT_SYSTEM_PROMPT, /refund/i, 'the system prompt is not specific to any workflow');
  const msg = compileFirstMessage(refundTriage, { order_id: 'ORD-1' });
  assert.ok(msg.includes(JSON.stringify(refundTriage, null, 2)), 'definition JSON is included as-is');
  assert.ok(msg.includes('"order_id": "ORD-1"'));
  const names = buildAgentTools().map((t) => t.name);
  assert.deepEqual(names.slice(0, 4), ['report_step', 'ask_human', 'wait', 'finish']);
  assert.ok(names.includes('issue_refund'));
});

test('rule expressions', async () => {
  const { evaluateRule } = await import('./expr');
  const ctx = { order: { amount: 136.99, ordered_days_ago: 12 }, customer: { account_status: 'active' }, inputs: { vip: true } };
  const yes = (src: string) => assert.deepEqual(evaluateRule(src, ctx), { ok: true, value: true }, src);
  const no = (src: string) => assert.deepEqual(evaluateRule(src, ctx), { ok: true, value: false }, src);
  yes('order.amount > 100');
  no('order.amount > 100 && order.ordered_days_ago > 30');
  yes('order.ordered_days_ago > 30 || customer.account_status == "active"');
  yes('not (customer.account_status == \'at_risk\') and inputs.vip');
  no('!inputs.vip');
  assert.equal(evaluateRule('refund.amount > 1', ctx).ok, false, 'missing data is not a match');
  assert.equal(evaluateRule('order.amount >', ctx).ok, false, 'syntax error');
});

test('invalid rules are errors', () => {
  const def = structuredClone(refundTriage);
  def.edges.find((e) => e.id === 'e4')!.when = 'order.amount >';
  const r = validateDefinition(def);
  assert.equal(r.ok, false);
  assert.match(r.issues.map((i) => i.message).join('\n'), /Rule "order.amount >" is invalid/);
});

test('duration fields are validated', () => {
  assert.deepEqual(validateFields({ d: { type: 'duration', required: true } }, { d: '15 minutes' }), ['"d" must be a duration like 30s, 10m, 2h or 1d']);
});

test('wait duration references are checked', async () => {
  const def = structuredClone(incidentResponse);
  const ack = def.nodes.find((n) => n.id === 'ack')!;
  if (ack.type !== 'human') throw new Error('expected human step');
  ack.form.settle_for = { type: 'text' };
  const msgs = validateDefinition(def).issues.map((i) => i.message).join('\n');
  assert.match(msgs, /which is a text field; make it a duration field/);
  assert.match(msgs, /which is optional/);
  const bad = structuredClone(incidentResponse);
  const wait = bad.nodes.find((n) => n.id === 'settle')!;
  if (wait.type === 'wait') wait.duration = 'a while';
  assert.equal(validateDefinition(bad).ok, false);
});

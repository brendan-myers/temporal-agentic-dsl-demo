/**
 * A tiny, safe expression language for decision rules (no eval):
 *
 *   order.amount > 100 || customer.account_status == "at_risk"
 *
 * Supports paths, numbers, "strings", true/false/null, == != > >= < <=,
 * && || ! (or `and` `or` `not`), and parentheses.
 */

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'path'; v: string }
  | { t: 'op'; v: string };

type Ast =
  | { k: 'lit'; v: unknown }
  | { k: 'path'; v: string }
  | { k: 'not'; e: Ast }
  | { k: 'bin'; op: string; l: Ast; r: Ast };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      toks.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('<>!()'.includes(c)) {
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error('Unterminated string');
      toks.push({ t: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      toks.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_][\w.]*/.exec(src.slice(i));
    if (word) {
      const w = word[0];
      if (w === 'and') toks.push({ t: 'op', v: '&&' });
      else if (w === 'or') toks.push({ t: 'op', v: '||' });
      else if (w === 'not') toks.push({ t: 'op', v: '!' });
      else toks.push({ t: 'path', v: w });
      i += w.length;
      continue;
    }
    throw new Error(`Unexpected "${c}"`);
  }
  return toks;
}

export function parseExpr(src: string): Ast {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;

  const or = (): Ast => {
    let l = and();
    while (isOp('||')) {
      pos++;
      l = { k: 'bin', op: '||', l, r: and() };
    }
    return l;
  };
  const and = (): Ast => {
    let l = not();
    while (isOp('&&')) {
      pos++;
      l = { k: 'bin', op: '&&', l, r: not() };
    }
    return l;
  };
  const not = (): Ast => {
    if (isOp('!')) {
      pos++;
      return { k: 'not', e: not() };
    }
    return cmp();
  };
  const cmp = (): Ast => {
    const l = primary();
    const t = peek();
    if (t?.t === 'op' && ['==', '!=', '>', '>=', '<', '<='].includes(t.v)) {
      pos++;
      return { k: 'bin', op: t.v, l, r: primary() };
    }
    return l;
  };
  const primary = (): Ast => {
    const t = toks[pos++];
    if (!t) throw new Error('Unexpected end of rule');
    if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'path') {
      if (t.v === 'true') return { k: 'lit', v: true };
      if (t.v === 'false') return { k: 'lit', v: false };
      if (t.v === 'null') return { k: 'lit', v: null };
      return { k: 'path', v: t.v };
    }
    if (t.v === '(') {
      const e = or();
      if (!isOp(')')) throw new Error('Missing ")"');
      pos++;
      return e;
    }
    throw new Error(`Unexpected "${t.v}"`);
  };

  const ast = or();
  if (pos < toks.length) throw new Error(`Unexpected "${(toks[pos] as { v: unknown }).v}"`);
  return ast;
}

/** Root names referenced by a rule, e.g. ["order", "customer"]. */
export function exprRoots(src: string): string[] {
  const roots = new Set<string>();
  const walk = (a: Ast) => {
    if (a.k === 'path') roots.add(a.v.split('.')[0]);
    else if (a.k === 'not') walk(a.e);
    else if (a.k === 'bin') {
      walk(a.l);
      walk(a.r);
    }
  };
  walk(parseExpr(src));
  return [...roots];
}

class MissingValue extends Error {}

function evalAst(a: Ast, ctx: Record<string, unknown>): unknown {
  switch (a.k) {
    case 'lit':
      return a.v;
    case 'path': {
      let cur: unknown = ctx;
      for (const part of a.v.split('.')) {
        if (cur == null || typeof cur !== 'object' || !(part in (cur as object))) throw new MissingValue(a.v);
        cur = (cur as Record<string, unknown>)[part];
      }
      return cur;
    }
    case 'not':
      return !evalAst(a.e, ctx);
    case 'bin': {
      if (a.op === '&&') return !!evalAst(a.l, ctx) && !!evalAst(a.r, ctx);
      if (a.op === '||') return !!evalAst(a.l, ctx) || !!evalAst(a.r, ctx);
      const l = evalAst(a.l, ctx);
      const r = evalAst(a.r, ctx);
      switch (a.op) {
        case '==':
          return l === r;
        case '!=':
          return l !== r;
        case '>':
          return (l as number) > (r as number);
        case '>=':
          return (l as number) >= (r as number);
        case '<':
          return (l as number) < (r as number);
        case '<=':
          return (l as number) <= (r as number);
      }
    }
  }
  return undefined;
}

export type RuleResult = { ok: true; value: boolean } | { ok: false; error: string };

/** Evaluate a rule. Missing data or a bad rule gives ok: false (the agent decides instead). */
export function evaluateRule(src: string, ctx: Record<string, unknown>): RuleResult {
  try {
    return { ok: true, value: !!evalAst(parseExpr(src), ctx) };
  } catch (err) {
    if (err instanceof MissingValue) return { ok: false, error: `No value for "${err.message}" yet` };
    return { ok: false, error: (err as Error).message };
  }
}

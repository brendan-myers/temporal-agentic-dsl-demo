import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WorkflowDefinitionSchema,
  sameDefinition,
  validateDefinition,
  type SavedFlow,
  type SavedFlowSummary,
  type WorkflowDefinition,
} from '@demo/dsl';
// The builder's templates seed the saved flows on first start.
import { EXAMPLES } from '../../web/src/examples';

/**
 * Saved flows, kept in one JSON file. Plenty for a demo; swap for a database
 * when several people edit at once.
 */
export class FlowStore {
  private flows = new Map<string, SavedFlow>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private file: string) {}

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, SavedFlow>;
      for (const [id, f] of Object.entries(raw)) this.flows.set(id, f);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // First start: seed the bundled templates so the Execute page isn't empty.
      // Parse so stored definitions always carry schema defaults (keeps change detection exact).
      for (const ex of EXAMPLES) this.put(WorkflowDefinitionSchema.parse(ex));
      await this.persist();
    }
  }

  list(): SavedFlowSummary[] {
    return [...this.flows.values()]
      .map(({ definition: d, ...meta }) => ({ ...meta, id: d.id, name: d.name, description: d.description, version: d.version, inputs: d.inputs }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): SavedFlow | undefined {
    return this.flows.get(id);
  }

  /**
   * Save a definition under its id. Drafts with errors can be saved but not
   * run. The version goes up whenever the content changes.
   */
  async save(raw: unknown): Promise<{ flow: SavedFlow; changed: boolean }> {
    const parsed = WorkflowDefinitionSchema.safeParse(raw);
    if (!parsed.success) throw new InvalidFlow(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    const existing = this.flows.get(parsed.data.id);
    const changed = !existing || !sameDefinition(existing.definition, parsed.data);
    if (!changed) return { flow: existing!, changed };
    const flow = this.put({ ...parsed.data, version: existing ? existing.definition.version + 1 : parsed.data.version });
    await this.persist();
    return { flow, changed };
  }

  async remove(id: string): Promise<boolean> {
    const had = this.flows.delete(id);
    if (had) await this.persist();
    return had;
  }

  private put(definition: WorkflowDefinition): SavedFlow {
    const now = new Date().toISOString();
    const { ok, issues } = validateDefinition(definition);
    const flow: SavedFlow = {
      definition,
      createdAt: this.flows.get(definition.id)?.createdAt ?? now,
      updatedAt: now,
      valid: ok,
      errorCount: issues.filter((i) => i.level === 'error').length,
    };
    this.flows.set(definition.id, flow);
    return flow;
  }

  private persist() {
    // Serialize writes and replace the file atomically.
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(this.flows), null, 2));
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}

export class InvalidFlow extends Error {
  constructor(public issues: string[]) {
    super('Not a valid workflow definition');
  }
}

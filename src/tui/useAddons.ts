import { useEffect, useState } from "react";
import { addAddon, listRows, openContext, removeAddon, syncAddons } from "../service";
import type { Context, Flavor, Progress, Row } from "../types";
import {
  cancelAdd,
  cancelConfirm,
  closeConfirm,
  initState,
  setError,
  setNotice,
  setProgress,
  setRows,
  setWorking,
  type TuiState,
} from "./model";

export type UpdateState = (update: (state: TuiState) => TuiState) => void;
interface Options {
  flavor?: Flavor;
  addonsDir?: string;
}
interface WorkOptions {
  signal: AbortSignal;
  onProgress: (progress: Progress) => void;
}

export class AddonActions {
  busy = false;
  private ctx?: Context;
  private initialFlavor?: Flavor;
  private generation = 0;
  private refreshAbort?: AbortController;
  private workAbort?: AbortController;

  constructor(
    private update: UpdateState,
    private options: Options,
  ) {}

  private invalidateRefresh() {
    this.refreshAbort?.abort();
    this.refreshAbort = undefined;
    return ++this.generation;
  }

  abort() {
    this.invalidateRefresh();
    this.workAbort?.abort();
  }

  private beginWork() {
    const generation = this.invalidateRefresh();
    const controller = new AbortController();
    this.workAbort = controller;
    this.busy = true;
    this.update((state) => setWorking(setNotice(state, undefined), true));
    return { generation, controller };
  }

  private finishWork(generation: number) {
    this.busy = false;
    this.workAbort = undefined;
    if (generation !== this.generation) return;
    this.update((state) => setWorking(state, false));
  }

  async loadContext(flavor = this.options.flavor) {
    if (this.busy) return;
    const { generation, controller } = this.beginWork();
    try {
      const ctx = await openContext({
        flavor,
        addonsDir:
          this.initialFlavor === undefined || flavor === this.initialFlavor
            ? this.options.addonsDir
            : undefined,
      });
      if (generation !== this.generation) return;
      this.initialFlavor ??= ctx.flavor;
      const rows = await listRows(ctx, { refresh: false, signal: controller.signal });
      if (generation !== this.generation) return;
      this.ctx = ctx;
      this.update((state) =>
        setRows(
          {
            ...state,
            flavor: ctx.flavor,
            addonsDir: ctx.addonsDir,
            selected: 0,
            progress: {},
          },
          rows,
        ),
      );
    } catch (error) {
      if (generation === this.generation) this.update((state) => setError(state, message(error)));
    } finally {
      this.finishWork(generation);
    }
    if (generation === this.generation) void this.refreshLatest();
  }

  async refreshLatest() {
    const ctx = this.ctx;
    if (!ctx || this.busy) return;
    const generation = this.invalidateRefresh();
    const controller = new AbortController();
    this.refreshAbort = controller;
    try {
      const rows = await listRows(ctx, { refresh: true, signal: controller.signal });
      if (generation === this.generation) this.update((state) => setRows(state, rows));
    } catch {
      // Background refresh keeps the last known rows on failure.
    } finally {
      if (this.refreshAbort === controller) this.refreshAbort = undefined;
    }
  }

  private async mutate(
    work: (ctx: Context, opts: WorkOptions) => Promise<(state: TuiState) => TuiState>,
  ) {
    if (!this.ctx || this.busy) return;
    const { generation, controller } = this.beginWork();
    const onProgress = (progress: Progress) => {
      if (generation === this.generation) this.update((state) => setProgress(state, progress));
    };
    try {
      const result = await work(this.ctx, { signal: controller.signal, onProgress });
      if (generation === this.generation) this.update(result);
    } catch (error) {
      if (generation === this.generation)
        this.update((state) => setError(cancelConfirm(state), message(error)));
    } finally {
      this.finishWork(generation);
    }
  }

  runSync(ids?: string[], adopt = false) {
    return this.mutate(async (ctx, opts) => {
      const rows = await syncAddons(ctx, { ...opts, ids, adopt });
      return (state) => setRows(setNotice(state, "sync complete"), mergeRows(state.rows, rows));
    });
  }

  runAdd(input: string) {
    return this.mutate(async (ctx, opts) => {
      const row = await addAddon(ctx, input, { ...opts, install: true });
      return (state) => setRows(cancelAdd(state), mergeRows(state.rows, [row]));
    });
  }

  runRemove(id: string) {
    return this.mutate(async (ctx, opts) => {
      await removeAddon(ctx, id, { signal: opts.signal });
      return (state) =>
        setRows(
          closeConfirm(state),
          state.rows.filter((row) => row.entry.id !== id),
        );
    });
  }
}

export function useAddons(options: Options) {
  const [state, setState] = useState(() => initState(options.flavor ?? "era", ""));
  const [actions] = useState(() => new AddonActions(setState, options));
  useEffect(() => {
    void actions.loadContext();
    return () => actions.abort();
  }, [actions]);
  return { state, setState, actions };
}

function mergeRows(existing: Row[], updated: Row[]): Row[] {
  const byId = new Map(existing.map((row) => [row.entry.id, row]));
  for (const row of updated) byId.set(row.entry.id, row);
  return [...byId.values()];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

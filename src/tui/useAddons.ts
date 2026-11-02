import { useEffect, useState } from "react";
import {
  addAddon,
  addonInfo,
  findAddons,
  listRows,
  openContext,
  removeAddon,
  syncAddons,
} from "../service";
import type { Context, Flavor, Listing, Progress, Row } from "../types";
import { failedResults, initBrowse, loadingResults, PAGE_LIMIT, setResults } from "./browse";
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
  updateBrowse,
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
  private searchAbort?: AbortController;
  private infoAbort?: AbortController;
  // Adds stopped by an unmanaged folder: shown as rows but not in the manifest, so taking one over
  // reruns its add with adopt instead of syncing it.
  private unsavedAdds = new Map<string, { input: string; note?: string }>();

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
    this.searchAbort?.abort();
    this.infoAbort?.abort();
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
      this.unsavedAdds.clear();
      this.update((state) =>
        setRows(
          {
            ...state,
            flavor: ctx.flavor,
            addonsDir: ctx.addonsDir,
            selected: 0,
            progress: {},
            // Another flavor has other addons, so its results start over.
            browse: ctx.flavor === state.flavor ? state.browse : initBrowse(),
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
      if (generation === this.generation) {
        this.unsavedAdds.clear();
        this.update((state) => setRows(state, rows));
      }
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
      const { rows } = await syncAddons(ctx, { ...opts, ids, adopt });
      return (state) => setRows(setNotice(state, "sync complete"), mergeRows(state.rows, rows));
    });
  }

  // Takes over an unmanaged row: a manifest addon syncs with adopt, an unsaved add reruns with it.
  runAdopt(id: string) {
    const unsaved = this.unsavedAdds.get(id);
    if (!unsaved) return this.runSync([id], true);
    return this.mutate(async (ctx, opts) => {
      const row = await this.add(ctx, unsaved.input, unsaved.note, opts, true);
      return (state) => setRows(setNotice(state, addNotice(row)), mergeRows(state.rows, [row]));
    });
  }

  private async add(
    ctx: Context,
    input: string,
    note: string | undefined,
    opts: WorkOptions,
    adopt = false,
  ) {
    const row = await addAddon(ctx, input, { ...opts, note, install: true, adopt });
    if (row.status === "unmanaged") this.unsavedAdds.set(row.entry.id, { input, note });
    else this.unsavedAdds.delete(row.entry.id);
    return row;
  }

  runAdd(input: string) {
    return this.mutate(async (ctx, opts) => {
      const row = await this.add(ctx, input, undefined, opts);
      return (state) =>
        setRows(setNotice(cancelAdd(state), addNotice(row)), mergeRows(state.rows, [row]));
    });
  }

  // A search or browse page for the browse view's query, order and page. A newer one replaces it.
  async search(browse: Pick<TuiState["browse"], "query" | "order" | "page">) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.searchAbort?.abort();
    const controller = new AbortController();
    this.searchAbort = controller;
    this.update((state) => updateBrowse(state, loadingResults));
    try {
      const found = await findAddons(
        ctx,
        {
          ...(browse.query ? { text: browse.query } : {}),
          order: browse.order,
          limit: PAGE_LIMIT,
          page: browse.page,
          allFlavors: false,
        },
        { signal: controller.signal },
      );
      if (this.searchAbort === controller && this.ctx === ctx)
        this.update((state) =>
          updateBrowse(state, (b) => setResults(b, found.results, found.sources)),
        );
    } catch (error) {
      if (this.searchAbort === controller && this.ctx === ctx)
        this.update((state) => updateBrowse(state, (b) => failedResults(b, message(error))));
    } finally {
      if (this.searchAbort === controller) this.searchAbort = undefined;
    }
  }

  async loadInfo(ref: string) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.infoAbort?.abort();
    const controller = new AbortController();
    this.infoAbort = controller;
    this.update((state) =>
      updateBrowse(state, (b) => ({ ...b, infoLoading: ref, infoError: undefined })),
    );
    try {
      const info = await addonInfo(ctx, ref, controller.signal);
      if (this.infoAbort === controller)
        this.update((state) =>
          updateBrowse(state, (b) => ({ ...b, info, infoLoading: undefined })),
        );
    } catch (error) {
      if (this.infoAbort === controller)
        this.update((state) =>
          updateBrowse(state, (b) => ({ ...b, infoLoading: undefined, infoError: message(error) })),
        );
    } finally {
      if (this.infoAbort === controller) this.infoAbort = undefined;
    }
  }

  runInstall(listing: Listing) {
    return this.mutate(async (ctx, opts) => {
      const row = await this.add(ctx, listing.ref, listing.name, opts);
      return (state) => setRows(setNotice(state, addNotice(row)), mergeRows(state.rows, [row]));
    });
  }

  runRemove(id: string) {
    return this.mutate(async (ctx, opts) => {
      // An unsaved add is only a row; there is nothing to remove from the manifest.
      if (!this.unsavedAdds.delete(id)) await removeAddon(ctx, id, { signal: opts.signal });
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

// What an add did, in words: an unmanaged folder is left in place until the user takes it over.
function addNotice(row: Row): string {
  const name = row.entry.note ?? row.entry.ref;
  if (row.status === "current") return `installed ${name} ${row.installed?.version ?? ""}`.trim();
  if (row.status === "unmanaged") return `${name} is installed outside wowaddon · u takes it over`;
  return `${name}: ${row.message ?? row.status}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

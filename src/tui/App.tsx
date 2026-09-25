import { homedir } from "node:os";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { addAddon, listRows, openContext, removeAddon, syncAddons } from "../service";
import type { Context, Flavor, Progress, Row } from "../types";
import {
  cancelAdd,
  cancelConfirm,
  closeConfirm,
  cycleFlavor as cycleFlavorPure,
  FOOTER_HINT,
  initState,
  moveSelection,
  NARROW_WIDTH_COLUMNS,
  openAdd,
  openAdoptConfirm,
  openRemoveConfirm,
  removePrompt,
  rowColumns,
  selectedRow,
  setError,
  setNotice,
  setProgress,
  setRows,
  setWorking,
  shortenPath,
  tableRows,
  toggleHelp,
  updateAddInput,
} from "./model";

interface AppProps {
  onQuit: (code: number) => void;
  flavor?: Flavor;
  addonsDir?: string;
}

const HOME = homedir();

export function App({ onQuit, flavor: startFlavor, addonsDir }: AppProps) {
  const [state, setState] = useState(() => initState(startFlavor ?? "era", ""));
  const ctxRef = useRef<Context | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const { width } = useTerminalDimensions();
  const narrow = width < NARROW_WIDTH_COLUMNS;

  function onProgress(progress: Progress) {
    setState((s) => setProgress(s, progress));
  }

  async function loadContext(flavor = startFlavor) {
    setState((s) => setWorking(setError(s, undefined), true));
    try {
      // --addons-dir names one flavor's folder; switching flavor goes back to that flavor's own.
      const ctx = await openContext({
        flavor,
        addonsDir: flavor === startFlavor ? addonsDir : undefined,
      });
      ctxRef.current = ctx;
      const rows = await listRows(ctx, { refresh: false });
      setState((s) =>
        setWorking(setRows({ ...s, flavor: ctx.flavor, addonsDir: ctx.addonsDir }, rows), false),
      );
      void refreshLatest();
    } catch (error) {
      setState((s) => setWorking(setError(s, message(error)), false));
    }
  }

  async function refreshLatest() {
    const ctx = ctxRef.current;
    if (!ctx) return;
    try {
      const rows = await listRows(ctx, { refresh: true });
      setState((s) => setRows(s, rows));
    } catch {
      // background refresh; keep the last known rows on failure
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount only
  useEffect(() => {
    void loadContext();
    return () => abortRef.current?.abort();
  }, []);

  async function runSync(ids?: string[], adopt = false) {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setState((s) => setWorking(setNotice(s, undefined), true));
    try {
      const rows = await syncAddons(ctx, { ids, adopt, signal: controller.signal, onProgress });
      setState((s) => {
        const merged = mergeRows(s.rows, rows);
        return setWorking(setRows(setNotice(s, "sync complete"), merged), false);
      });
    } catch (error) {
      setState((s) => setWorking(setError(s, message(error)), false));
    } finally {
      abortRef.current = undefined;
    }
  }

  async function runAdd() {
    const ctx = ctxRef.current;
    if (!ctx || !state.addDetected) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const input = state.addInput;
    setState((s) => setWorking(s, true));
    try {
      const row = await addAddon(ctx, input, {
        install: true,
        signal: controller.signal,
        onProgress,
      });
      setState((s) => {
        const rows = mergeRows(s.rows, [row]);
        return setWorking(setRows(cancelAdd(s), rows), false);
      });
    } catch (error) {
      setState((s) => setWorking(setError(s, message(error)), false));
    } finally {
      abortRef.current = undefined;
    }
  }

  async function runRemove() {
    const ctx = ctxRef.current;
    const id = state.confirmId;
    if (!ctx || !id) return;
    setState((s) => setWorking(s, true));
    try {
      await removeAddon(ctx, id);
      setState((s) => {
        const rows = s.rows.filter((row) => row.entry.id !== id);
        return setWorking(setRows(closeConfirm(s), rows), false);
      });
    } catch (error) {
      setState((s) => setWorking(setError(closeConfirm(s), message(error)), false));
    }
  }

  async function runAdopt() {
    const id = state.confirmId;
    if (!id) return;
    setState((s) => closeConfirm(s));
    await runSync([id], true);
  }

  useKeyboard((key) => {
    if (state.mode === "add") {
      if (key.name === "escape") setState((s) => cancelAdd(s));
      else if (key.name === "return" && state.addDetected) void runAdd();
      return;
    }
    if (state.mode === "remove-confirm") {
      if (key.sequence === "y") void runRemove();
      else if (key.name === "escape" || key.sequence === "n") setState((s) => cancelConfirm(s));
      return;
    }
    if (state.mode === "adopt-confirm") {
      if (key.sequence === "y") void runAdopt();
      else if (key.name === "escape" || key.sequence === "n") setState((s) => cancelConfirm(s));
      return;
    }
    if (state.mode === "help") {
      if (key.name === "escape" || key.sequence === "?") setState((s) => toggleHelp(s));
      return;
    }

    if (state.working) {
      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        abortRef.current?.abort();
        onQuit(0);
      }
      return;
    }

    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      onQuit(0);
      return;
    }
    if (key.name === "up" || key.name === "k") setState((s) => moveSelection(s, -1));
    else if (key.name === "down" || key.name === "j") setState((s) => moveSelection(s, 1));
    else if (key.sequence === "a") setState((s) => openAdd(s));
    else if (key.sequence === "x") setState((s) => openRemoveConfirm(s));
    else if (key.sequence === "f") {
      const next: Flavor = state.flavor === "era" ? "forever" : "era";
      setState((s) => cycleFlavorPure(s));
      void loadContext(next);
    } else if (key.sequence === "r") void refreshLatest();
    else if (key.sequence === "U") void runSync();
    else if (key.sequence === "u") {
      const row = selectedRow(state);
      if (!row) return;
      if (row.status === "unmanaged") setState((s) => openAdoptConfirm(s));
      else void runSync([row.entry.id]);
    } else if (key.sequence === "?") setState((s) => toggleHelp(s));
  });

  const header = `${state.flavor} · ${shortenPath(state.addonsDir || "…", HOME)}`;
  const active = selectedRow(state);

  return (
    <box flexDirection="column" flexGrow={1} padding={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD}>{header}</text>
        {state.working ? <text attributes={TextAttributes.DIM}>working…</text> : null}
      </box>

      {state.mode === "help" ? (
        <HelpView />
      ) : (
        <>
          <box flexDirection="column">
            {state.rows.length === 0 ? (
              <text attributes={TextAttributes.DIM}>no addons yet · press a to add one</text>
            ) : (
              tableRows(
                state.rows.map((row) => rowColumns(row, state.progress[row.entry.id])),
                narrow
                  ? ["name", "installed", "status"]
                  : ["name", "source", "installed", "latest", "status"],
              ).map((line, index) => (
                <text
                  key={state.rows[index].entry.id}
                  attributes={index === state.selected ? TextAttributes.BOLD : TextAttributes.NONE}
                >
                  {`${index === state.selected ? "›" : " "} ${line}`}
                </text>
              ))
            )}
          </box>

          {active ? <DetailsView row={active} /> : null}

          {state.mode === "add" ? (
            <box flexDirection="column">
              <text attributes={TextAttributes.DIM}>
                paste a ref or URL · Enter adds · Esc cancels
              </text>
              <input
                focused
                placeholder="OWNER/REPO, cf <slug>, wowi <id>, or a URL"
                value={state.addInput}
                onInput={(value) => setState((s) => updateAddInput(s, value))}
                onSubmit={() => {
                  if (state.addDetected) void runAdd();
                }}
              />
              {state.addDetected ? (
                <text attributes={TextAttributes.DIM}>
                  detected: {state.addDetected.kind} {state.addDetected.ref}
                </text>
              ) : state.addError ? (
                <text attributes={TextAttributes.DIM}>{state.addError}</text>
              ) : null}
            </box>
          ) : null}

          {state.mode === "remove-confirm" && active ? <text>{removePrompt(active)}</text> : null}

          {state.mode === "adopt-confirm" && active ? (
            <text>take over {active.entry.note ?? active.entry.ref}? y/n</text>
          ) : null}

          {state.error ? <text>{state.error}</text> : null}
          {state.notice ? <text attributes={TextAttributes.DIM}>{state.notice}</text> : null}
        </>
      )}

      <box flexGrow={1} />
      <text attributes={TextAttributes.DIM}>{FOOTER_HINT}</text>
    </box>
  );
}

function mergeRows(existing: Row[], updated: Row[]): Row[] {
  const byId = new Map(existing.map((row) => [row.entry.id, row]));
  for (const row of updated) byId.set(row.entry.id, row);
  return [...byId.values()];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function DetailsView({ row }: { row: Row }) {
  const folders = row.installed?.folders ?? [];
  return (
    <box flexDirection="column">
      <text attributes={TextAttributes.DIM}>
        {row.entry.id}
        {folders.length ? ` · ${folders.join(", ")}` : ""}
      </text>
      {row.message ? <text attributes={TextAttributes.DIM}>{row.message}</text> : null}
    </box>
  );
}

const HELP: [string, string][] = [
  ["↑ ↓  j k", "move"],
  ["u", "update the selected addon, or take over one installed outside wowaddon"],
  ["U", "update everything"],
  ["a", "add an addon: paste a GitHub, CurseForge or WoWInterface URL or ref"],
  ["x", "remove the selected addon's folders"],
  ["f", "switch between Classic Era and WoW: Forever"],
  ["r", "check for new versions"],
  ["?  esc", "close this help"],
  ["q", "quit"],
];

function HelpView() {
  return (
    <box flexDirection="column">
      {HELP.map(([keys, action]) => (
        <text key={keys}>
          <span attributes={TextAttributes.BOLD}>{keys.padEnd(10)}</span>
          {action}
        </text>
      ))}
    </box>
  );
}

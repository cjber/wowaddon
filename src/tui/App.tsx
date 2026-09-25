import { homedir } from "node:os";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import type { Flavor, Row } from "../types";
import { handleKey } from "./keymap";
import {
  FOOTER_HINT,
  NARROW_WIDTH_COLUMNS,
  removePrompt,
  rowColumns,
  selectedRow,
  shortenPath,
  type TuiState,
  tableRows,
  updateAddInput,
} from "./model";
import { type AddonActions, type UpdateState, useAddons } from "./useAddons";

interface AppProps {
  onQuit: (code: number) => void;
  flavor?: Flavor;
  addonsDir?: string;
}
const HOME = homedir();

export function App({ onQuit, flavor, addonsDir }: AppProps) {
  const { state, setState, actions } = useAddons({ flavor, addonsDir });
  const { width, height } = useTerminalDimensions();
  useKeyboard((key) => handleKey(key, state, setState, actions, onQuit));
  const active = selectedRow(state);
  const detailsHeight = active ? 1 + Number(Boolean(active.message)) : 0;
  const modalHeight = state.mode === "add" ? 3 : Number(state.mode.endsWith("-confirm"));
  const rowsHeight = Math.max(
    1,
    height -
      6 -
      detailsHeight -
      modalHeight -
      Number(Boolean(state.error)) -
      Number(Boolean(state.notice)),
  );

  return (
    <box flexDirection="column" width={width} height={height} padding={1} overflow="hidden">
      <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
        <Line bold>{`${state.flavor} · ${shortenPath(state.addonsDir || "…", HOME)}`}</Line>
        {state.working ? <Line dim>working…</Line> : null}
      </box>
      <box height={1} flexShrink={0} />
      {state.mode === "help" ? (
        <HelpView />
      ) : (
        <>
          <AddonList state={state} height={rowsHeight} narrow={width < NARROW_WIDTH_COLUMNS} />
          <box height={1} flexShrink={0} />
          {active ? <DetailsView row={active} /> : null}
          <ModalView state={state} update={setState} actions={actions} />
          {state.error ? <Line>{state.error}</Line> : null}
          {state.notice ? <Line dim>{state.notice}</Line> : null}
        </>
      )}
      <box flexGrow={1} />
      <Line dim>{FOOTER_HINT}</Line>
    </box>
  );
}

function Line({ children, dim, bold }: { children: ReactNode; dim?: boolean; bold?: boolean }) {
  return (
    <text
      height={1}
      flexShrink={0}
      wrapMode="none"
      truncate
      attributes={bold ? TextAttributes.BOLD : dim ? TextAttributes.DIM : TextAttributes.NONE}
    >
      {children}
    </text>
  );
}

function AddonList({
  state,
  height,
  narrow,
}: {
  state: TuiState;
  height: number;
  narrow: boolean;
}) {
  const count = state.rows.length > height ? Math.max(1, height - 2) : state.rows.length;
  const start = Math.max(0, Math.min(state.selected - count + 1, state.rows.length - count));
  const end = start + count;
  const lines = tableRows(
    state.rows.map((row) => rowColumns(row, state.progress[row.entry.id])),
    narrow ? ["name", "installed", "status"] : ["name", "source", "installed", "latest", "status"],
  );
  return (
    <box flexDirection="column" height={height} flexShrink={0} overflow="hidden">
      {start > 0 ? <Line dim>{`↑ ${start} more`}</Line> : null}
      {state.rows.length === 0 ? (
        <Line dim>no addons yet · press a to add one</Line>
      ) : (
        lines.slice(start, end).map((line, index) => (
          <Line key={state.rows[start + index].entry.id} bold={start + index === state.selected}>
            {`${start + index === state.selected ? "›" : " "} ${line}`}
          </Line>
        ))
      )}
      {end < state.rows.length ? <Line dim>{`↓ ${state.rows.length - end} more`}</Line> : null}
    </box>
  );
}

function ModalView({
  state,
  update,
  actions,
}: {
  state: TuiState;
  update: UpdateState;
  actions: AddonActions;
}) {
  const active = selectedRow(state);
  if (state.mode === "add")
    return (
      <box flexDirection="column" height={3} flexShrink={0}>
        <Line dim>paste a ref or URL · Enter adds · Esc cancels</Line>
        <input
          focused={!state.working}
          flexShrink={0}
          placeholder="OWNER/REPO, cf <slug>, wowi <id>, or a URL"
          value={state.addInput}
          onInput={(value) => {
            if (!actions.busy) update((s) => updateAddInput(s, value));
          }}
          onSubmit={() => {
            if (state.addDetected) void actions.runAdd(state.addInput);
          }}
        />
        <Line dim>
          {state.addDetected
            ? `detected: ${state.addDetected.kind} ${state.addDetected.ref}`
            : (state.addError ?? "")}
        </Line>
      </box>
    );
  if (state.mode === "remove-confirm" && active) return <Line>{removePrompt(active)}</Line>;
  if (state.mode === "adopt-confirm" && active)
    return <Line>{`take over ${active.entry.note ?? active.entry.ref}? y/n`}</Line>;
  return null;
}

function DetailsView({ row }: { row: Row }) {
  const folders = row.installed?.folders ?? [];
  return (
    <box flexDirection="column" flexShrink={0}>
      <Line dim>
        {row.entry.id}
        {folders.length ? ` · ${folders.join(", ")}` : ""}
      </Line>
      {row.message ? <Line dim>{row.message}</Line> : null}
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
        <Line key={keys}>
          <span attributes={TextAttributes.BOLD}>{keys.padEnd(10)}</span>
          {action}
        </Line>
      ))}
    </box>
  );
}

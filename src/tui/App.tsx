import { homedir } from "node:os";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import type { AddonInfo, Flavor, Listing, Row } from "../types";
import {
  type BrowseState,
  browseLines,
  ORDER_LABEL,
  selectedListing,
  sourceNotice,
  submitSearch,
  windowStart,
} from "./browse";
import { handleKey } from "./keymap";
import {
  installedIds,
  KEYS,
  keyLines,
  NARROW_WIDTH_COLUMNS,
  removePrompt,
  rowColumns,
  selectedRow,
  shortenPath,
  type TuiState,
  tableRows,
  updateAddInput,
  updateBrowse,
} from "./model";
import { type AddonActions, type UpdateState, useAddons } from "./useAddons";

interface AppProps {
  onQuit: (code: number) => void;
  flavor?: Flavor;
  addonsDir?: string;
}
const HOME = homedir();
// Terminal palette entries, as keeper uses, so the colours follow the terminal's theme.
const ink = {
  accent: RGBA.fromIndex(6),
  group: RGBA.fromIndex(4),
  good: RGBA.fromIndex(2),
  warn: RGBA.fromIndex(3),
  bad: RGBA.fromIndex(1),
};
// The pane under the list has the same height in both views, as does everything else around the
// list, so switching views never moves a line.
const DETAIL_ROWS = 6;
const DETAIL_PARTS = ["title", "summary", "stats", "tags", "more"];

export function App({ onQuit, flavor, addonsDir }: AppProps) {
  const { state, setState, actions } = useAddons({ flavor, addonsDir });
  const { width, height } = useTerminalDimensions();
  const keys = keyLines(width);
  const panel = Math.max(3, height - 1 - DETAIL_ROWS - 1 - keys);
  useKeyboard((key) => handleKey(key, state, setState, actions, onQuit, panel));
  const browsing = state.view === "browse";

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
    >
      <Line bold fg={ink.accent}>
        {browsing ? browseHeader(state, panel) : installedHeader(state, panel)}
      </Line>
      <box flexDirection="column" height={panel} flexShrink={0} overflow="hidden">
        {browsing ? (
          <BrowseList state={state} height={panel} width={width - 2} />
        ) : state.mode === "help" ? (
          <HelpView />
        ) : (
          <AddonList state={state} height={panel} narrow={width < NARROW_WIDTH_COLUMNS} />
        )}
      </box>
      <box flexDirection="column" height={DETAIL_ROWS} flexShrink={0} overflow="hidden">
        {browsing ? (
          <BrowseDetail browse={state.browse} installed={installedIds(state)} />
        ) : (
          <InstalledDetail state={state} update={setState} actions={actions} />
        )}
      </box>
      <StatusLine state={state} update={setState} actions={actions} />
      {/* One text per binding, so a narrow terminal wraps between bindings, never inside one. */}
      <box flexDirection="row" flexWrap="wrap" height={keys} flexShrink={0}>
        {KEYS[state.view].map((binding, index, all) => (
          <text key={binding} wrapMode="none" attributes={TextAttributes.DIM}>
            {binding}
            {index < all.length - 1 ? " · " : ""}
          </text>
        ))}
      </box>
    </box>
  );
}

function installedHeader(state: TuiState, panel: number): string {
  const total = state.rows.length;
  const updates = state.rows.filter((row) => row.status === "update" || row.status === "missing");
  const count = total > panel ? Math.max(1, panel - 2) : total;
  const start = windowStart(state.selected, total, count);
  return [
    "wowaddon · installed",
    `${state.flavor} · ${shortenPath(state.addonsDir || "…", HOME)}`,
    `${total} addons${updates.length ? `, ${updates.length} to update` : ""}`,
    ...(total > count ? [`${start + 1}-${start + count}/${total}`] : []),
  ].join(" · ");
}

function browseHeader(state: TuiState, panel: number): string {
  const { browse } = state;
  const lines = browseLines(browse).length;
  const start = windowStart(browse.cursor, lines, panel);
  return [
    "wowaddon · browse",
    state.flavor,
    ...(browse.query ? [`"${browse.query}"`] : []),
    ORDER_LABEL[browse.order],
    `page ${browse.page}`,
    `${browse.results.length} addons`,
    ...(lines > panel ? [`${start + 1}-${start + panel}/${lines}`] : []),
  ].join(" · ");
}

function Line({
  children,
  dim,
  bold,
  inverse,
  fg,
}: {
  children: ReactNode;
  dim?: boolean;
  bold?: boolean;
  inverse?: boolean;
  fg?: RGBA;
}) {
  const attributes =
    (bold ? TextAttributes.BOLD : dim ? TextAttributes.DIM : TextAttributes.NONE) |
    (inverse ? TextAttributes.INVERSE : 0);
  return (
    <text height={1} flexShrink={0} wrapMode="none" truncate fg={fg} attributes={attributes}>
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
  const start = windowStart(state.selected, state.rows.length, count);
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

function InstalledDetail({
  state,
  update,
  actions,
}: {
  state: TuiState;
  update: UpdateState;
  actions: AddonActions;
}) {
  const active = selectedRow(state);
  if (state.mode === "help") return null;
  return (
    <>
      {active ? <DetailsView row={active} /> : null}
      <ModalView state={state} update={update} actions={actions} />
    </>
  );
}

function StatusLine({
  state,
  update,
  actions,
}: {
  state: TuiState;
  update: UpdateState;
  actions: AddonActions;
}) {
  const { browse } = state;
  if (state.view === "browse" && browse.typing)
    return (
      <box flexDirection="row" height={1} flexShrink={0}>
        <text wrapMode="none" fg={ink.accent} flexShrink={0}>
          {"search: "}
        </text>
        <input
          focused
          flexGrow={1}
          placeholder="name or words · enter searches · esc cancels"
          value={browse.input}
          onInput={(value) => update((s) => updateBrowse(s, (b) => ({ ...b, input: value })))}
          onSubmit={() => {
            const next = submitSearch({ ...browse });
            update((s) => updateBrowse(s, submitSearch));
            void actions.search(next);
          }}
        />
      </box>
    );
  if (state.error) return <Line fg={ink.bad}>{state.error}</Line>;
  if (state.working) return <Line fg={ink.accent}>working…</Line>;
  if (state.notice) return <Line fg={ink.good}>{state.notice}</Line>;
  if (state.view === "browse") {
    if (browse.loading) return <Line fg={ink.accent}>searching…</Line>;
    const skipped = sourceNotice(browse);
    return <Line dim>{skipped ? `not searched: ${skipped}` : ""}</Line>;
  }
  return <Line dim> </Line>;
}

const compact = (n: number | null) =>
  n === null
    ? "-"
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : String(n);
const clip = (text: string, room: number) =>
  text.length > room ? `${text.slice(0, Math.max(room - 1, 0))}…` : text;

function BrowseList({ state, height, width }: { state: TuiState; height: number; width: number }) {
  const { browse } = state;
  const lines = browseLines(browse);
  const installed = installedIds(state);
  if (!lines.length)
    return (
      <Line dim>
        {browse.loading
          ? "searching…"
          : browse.loaded
            ? "no addons found · / searches · o changes the sort"
            : "tab loads trending addons"}
      </Line>
    );
  const at = Math.min(browse.cursor, lines.length - 1);
  const start = windowStart(at, lines.length, height);
  return (
    <>
      {lines.slice(start, start + height).map((line, offset) => {
        const index = start + offset;
        const cursor = index === at;
        if (line.kind === "group")
          return (
            <Line key={`group-${line.group.name}`} bold fg={ink.group} inverse={cursor}>
              {`${line.group.folded ? "▸" : "▾"} ${line.group.name} ${line.group.items.length}`}
            </Line>
          );
        const listing = line.listing;
        const mark = installed.has(listing.ref) ? "✓ " : "  ";
        const row = `${mark}${clip(listing.name, 30).padEnd(30)} ${listing.kind.padEnd(5)} ${compact(listing.downloads).padStart(6)}  ${(listing.updated ?? "").slice(0, 10).padEnd(10)}  ${listing.summary}`;
        return (
          <Line
            key={`${line.listing.ref}-${index}`}
            inverse={cursor}
            fg={installed.has(listing.ref) ? ink.good : undefined}
          >
            {clip(`  ${row}`, width)}
          </Line>
        );
      })}
    </>
  );
}

function BrowseDetail({ browse, installed }: { browse: BrowseState; installed: Set<string> }) {
  const listing = selectedListing(browse);
  if (!listing) return <Line dim>enter opens a group · h/l folds · / searches</Line>;
  const details: AddonInfo | undefined = browse.info?.ref === listing.ref ? browse.info : undefined;
  const info: Listing = details ?? listing;
  const lines = [
    `${info.name} · ${info.ref}${installed.has(info.ref) ? " · installed" : ""}`,
    info.summary,
    `by ${info.authors.join(", ") || "unknown"} · ${compact(info.downloads)} downloads · updated ${(info.updated ?? "unknown").slice(0, 10)}${details?.version ? ` · latest ${details.version}` : ""}`,
    `${info.flavors.join(", ") || "no flavor tags"}${info.categories.length ? ` · ${info.categories.join(", ")}` : ""}`,
  ];
  if (browse.infoLoading === listing.ref) lines.push("loading details…");
  else if (browse.infoError && !details) lines.push(browse.infoError);
  else if (details?.changelog)
    lines.push(
      `changelog ${details.changelog.version ?? ""}: ${details.changelog.text.replace(/\s+/g, " ")}`,
    );
  else if (details) lines.push(details.description.replace(/\s+/g, " "));
  else lines.push("enter shows details and changelog · i installs");
  return (
    <>
      {DETAIL_PARTS.map((part, index) => (
        <Line key={part} bold={index === 0} dim={index > 1}>
          {lines[index] ?? ""}
        </Line>
      ))}
    </>
  );
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
  ["tab", "browse and search for addons to install"],
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

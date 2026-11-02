import { homedir } from "node:os";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import type { AddonInfo, Flavor, Listing, Row, SourceKind, Status } from "../types";
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
  KEY_GAP,
  keyLines,
  keyUnits,
  NARROW_WIDTH_COLUMNS,
  removePrompt,
  rowColumns,
  selectedRow,
  shortenPath,
  statusLabel,
  type TuiState,
  tableRows,
  updateAddInput,
  updateBrowse,
  type View,
} from "./model";
import { type AddonActions, type UpdateState, useAddons } from "./useAddons";

interface AppProps {
  onQuit: (code: number) => void;
  flavor?: Flavor;
  addonsDir?: string;
}
const HOME = homedir();
// Terminal palette entries, as keeper uses, so the colours follow the terminal's theme. Unset
// text is the terminal's own foreground rather than OpenTUI's fixed white.
const ink = {
  text: RGBA.defaultForeground(),
  accent: RGBA.fromIndex(6),
  group: RGBA.fromIndex(4),
  good: RGBA.fromIndex(2),
  warn: RGBA.fromIndex(3),
  bad: RGBA.fromIndex(1),
  dev: RGBA.fromIndex(5),
};
// Sources take the bright half of the palette, so a source tag never reads as a status.
const SOURCE_INK: Record<SourceKind, RGBA> = {
  gh: RGBA.fromIndex(13),
  cf: RGBA.fromIndex(11),
  wowi: RGBA.fromIndex(12),
  tukui: RGBA.fromIndex(10),
  wago: RGBA.fromIndex(14),
};
const STATUS_INK: Record<Status, RGBA | undefined> = {
  current: ink.good,
  update: ink.warn,
  missing: ink.warn,
  unknown: undefined,
  dev: ink.dev,
  unmanaged: ink.group,
  error: ink.bad,
};
// The pane under the list has the same height in both views, as does everything else around the
// list, so switching views never moves a line.
const DETAIL_ROWS = 6;
const DETAIL_PARTS = ["title", "summary", "stats", "tags", "more"];

// One coloured run of a line.
interface Seg {
  text: string;
  fg?: RGBA;
  dim?: boolean;
  bold?: boolean;
}
const dim = (text: string): Seg => ({ text, dim: true });
const SEP = dim(" · ");
const joined = (parts: Seg[][]) => parts.flatMap((part, index) => (index ? [SEP, ...part] : part));
// The selected row's marker, the same in both views.
const marker = (selected: boolean): Seg =>
  selected ? { text: "› ", fg: ink.accent, bold: true } : { text: "  " };

export function App({ onQuit, flavor, addonsDir }: AppProps) {
  const { state, setState, actions } = useAddons({ flavor, addonsDir });
  const { width, height } = useTerminalDimensions();
  const keys = keyLines(width);
  const panel = Math.max(3, height - 1 - DETAIL_ROWS - 1 - keys);
  useKeyboard((key) => handleKey(key, state, setState, actions, onQuit, panel));
  const browsing = state.view === "browse";
  const help = state.mode === "help";

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
    >
      <Segs segs={browsing ? browseHeader(state, panel) : installedHeader(state, panel)} />
      <box flexDirection="column" height={panel} flexShrink={0} overflow="hidden">
        {help ? (
          <HelpView view={state.view} />
        ) : browsing ? (
          <BrowseList state={state} height={panel} width={width - 2} />
        ) : (
          <AddonList state={state} height={panel} narrow={width < NARROW_WIDTH_COLUMNS} />
        )}
      </box>
      <box flexDirection="column" height={DETAIL_ROWS} flexShrink={0} overflow="hidden">
        {help ? null : browsing ? (
          <BrowseDetail browse={state.browse} installed={installedIds(state)} />
        ) : (
          <InstalledDetail state={state} update={setState} actions={actions} />
        )}
      </box>
      <StatusLine state={state} update={setState} actions={actions} />
      {/* One text per unit, so a narrow terminal wraps between bindings, never inside one. */}
      <box flexDirection="row" flexWrap="wrap" height={keys} flexShrink={0}>
        {keyUnits(state.view).map((unit, index, all) => (
          <text key={unit[0]} wrapMode="none" fg={ink.text}>
            {unit.map((binding, at) => {
              const space = binding.indexOf(" ");
              const last = at === unit.length - 1 && index === all.length - 1;
              return (
                <span key={binding}>
                  <span fg={ink.accent}>{binding.slice(0, space)}</span>
                  <span attributes={TextAttributes.DIM}>
                    {binding.slice(space)}
                    {last ? "" : KEY_GAP}
                  </span>
                </span>
              );
            })}
          </text>
        ))}
      </box>
    </box>
  );
}

function installedHeader(state: TuiState, panel: number): Seg[] {
  const total = state.rows.length;
  const updates = state.rows.filter((row) => row.status === "update" || row.status === "missing");
  const count = total > panel ? Math.max(1, panel - 2) : total;
  const start = windowStart(state.selected, total, count);
  return joined([
    [{ text: "wowaddon", fg: ink.accent, bold: true }],
    [{ text: "installed", bold: true }],
    [{ text: state.flavor }],
    [dim(shortenPath(state.addonsDir || "…", HOME))],
    [
      { text: `${total} ${total === 1 ? "addon" : "addons"}` },
      ...(updates.length ? [{ text: `, ${updates.length} to update`, fg: ink.warn }] : []),
    ],
    ...(total > count ? [[dim(`${start + 1}-${start + count}/${total}`)]] : []),
  ]);
}

function browseHeader(state: TuiState, panel: number): Seg[] {
  const { browse } = state;
  const lines = browseLines(browse).length;
  const start = windowStart(browse.cursor, lines, panel);
  return joined([
    [{ text: "wowaddon", fg: ink.accent, bold: true }],
    [{ text: "browse", bold: true }],
    [{ text: state.flavor }],
    ...(browse.query ? [[{ text: `"${browse.query}"`, fg: ink.accent }]] : []),
    [{ text: ORDER_LABEL[browse.order] }],
    [dim(`page ${browse.page}`)],
    [{ text: `${browse.results.length} addons` }],
    ...(lines > panel ? [[dim(`${start + 1}-${start + panel}/${lines}`)]] : []),
  ]);
}

function Line({ children, dim, fg }: { children: ReactNode; dim?: boolean; fg?: RGBA }) {
  return (
    <text
      height={1}
      flexShrink={0}
      wrapMode="none"
      truncate
      fg={fg ?? ink.text}
      attributes={dim ? TextAttributes.DIM : TextAttributes.NONE}
    >
      {children}
    </text>
  );
}

function Segs({ segs }: { segs: Seg[] }) {
  return (
    <Line>
      {segs.map((seg, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a line's runs never reorder
          key={index}
          fg={seg.fg}
          attributes={
            seg.bold ? TextAttributes.BOLD : seg.dim ? TextAttributes.DIM : TextAttributes.NONE
          }
        >
          {seg.text}
        </span>
      ))}
    </Line>
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
  const keys = narrow
    ? (["name", "installed", "status"] as const)
    : (["name", "source", "installed", "latest", "status"] as const);
  const lines = tableRows(
    state.rows.map((row) => rowColumns(row, state.progress[row.entry.id])),
    [...keys],
  );
  const cellInk = (row: Row, key: (typeof keys)[number], selected: boolean): Partial<Seg> => {
    if (key === "name") return { bold: selected };
    if (key === "source") return { fg: SOURCE_INK[row.entry.kind] };
    if (key === "installed") return { dim: true };
    if (key === "latest") return { fg: ink.warn };
    if (state.progress[row.entry.id]) return { fg: ink.accent };
    return { fg: STATUS_INK[row.status], dim: !STATUS_INK[row.status] };
  };
  return (
    <box flexDirection="column" height={height} flexShrink={0} overflow="hidden">
      {start > 0 ? <Line dim>{`↑ ${start} more`}</Line> : null}
      {state.rows.length === 0 ? (
        <Line dim>no addons yet · press a to add one</Line>
      ) : (
        lines.slice(start, end).map((cells, index) => {
          const row = state.rows[start + index];
          const selected = start + index === state.selected;
          return (
            <Segs
              key={row.entry.id}
              segs={[
                marker(selected),
                ...cells.flatMap((cell, at) => [
                  ...(at ? [{ text: "  " }] : []),
                  { text: cell, ...cellInk(row, keys[at], selected) },
                ]),
              ]}
            />
          );
        })
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
        {state.addDetected ? (
          <Segs
            segs={[
              dim("detected: "),
              { text: state.addDetected.kind, fg: SOURCE_INK[state.addDetected.kind] },
              { text: ` ${state.addDetected.ref}` },
            ]}
          />
        ) : (
          <Line fg={ink.bad}>{state.addError ?? ""}</Line>
        )}
      </box>
    );
  if (state.mode === "remove-confirm" && active)
    return <Line fg={ink.warn}>{removePrompt(active)}</Line>;
  if (state.mode === "adopt-confirm" && active)
    return <Line fg={ink.accent}>{`take over ${active.entry.note ?? active.entry.ref}? y/n`}</Line>;
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
  if (state.mode === "add") return <ModalView state={state} update={update} actions={actions} />;
  const active = selectedRow(state);
  // A confirmation takes the pane's last row, under the facts it is about.
  const confirming = state.mode === "remove-confirm" || state.mode === "adopt-confirm";
  const facts = active ? rowFacts(active) : [];
  return (
    <>
      {facts.slice(0, confirming ? DETAIL_ROWS - 1 : DETAIL_ROWS).map((segs, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the pane's rows are fixed slots
        <Segs key={index} segs={segs} />
      ))}
      {confirming ? <ModalView state={state} update={update} actions={actions} /> : null}
    </>
  );
}

const label = (text: string) => dim(text.padEnd(10));

// The installed view's pane: what wowaddon knows about the selected addon, one fact a row.
function rowFacts(row: Row): Seg[][] {
  const { entry, installed, latest } = row;
  const folders = installed?.folders ?? [];
  return [
    [
      { text: entry.note ?? entry.ref, bold: true },
      { text: "  " },
      { text: entry.kind, fg: SOURCE_INK[entry.kind] },
      dim(entry.id.slice(entry.kind.length)),
    ],
    [
      label("status"),
      { text: statusLabel(row) || "not checked yet", fg: STATUS_INK[row.status] },
      ...(row.message ? [SEP, { text: row.message, fg: ink.bad }] : []),
    ],
    [label("version"), installed ? { text: installed.version } : dim("none")],
    [
      label("latest"),
      ...(latest
        ? [
            {
              text: latest.version,
              fg: latest.version !== installed?.version ? ink.warn : undefined,
            },
            ...(latest.note ? [dim(` ${latest.note}`)] : []),
          ]
        : [dim("not known")]),
    ],
    [label("installed"), installed ? { text: installed.installedAt.slice(0, 10) } : dim("never")],
    [label("folders"), folders.length ? { text: folders.join(", ") } : dim("none")],
  ];
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
    return <Line fg={ink.warn}>{skipped ? `not searched: ${skipped}` : ""}</Line>;
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

// Cuts a line of runs to the room, ending in "…" when it does not fit.
function clipSegs(segs: Seg[], room: number): Seg[] {
  if (segs.reduce((sum, seg) => sum + seg.text.length, 0) <= room) return segs;
  const out: Seg[] = [];
  let left = room - 1;
  for (const seg of segs) {
    if (left <= 0) break;
    out.push({ ...seg, text: seg.text.slice(0, left) });
    left -= seg.text.length;
  }
  return [...out, dim("…")];
}

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
            <Segs
              key={`group-${line.group.name}`}
              segs={[
                marker(cursor),
                {
                  text: `${line.group.folded ? "▸" : "▾"} ${line.group.name} `,
                  fg: ink.group,
                  bold: true,
                },
                dim(String(line.group.items.length)),
              ]}
            />
          );
        const listing = line.listing;
        const owned = installed.has(listing.ref);
        const segs: Seg[] = [
          marker(cursor),
          { text: owned ? "✓ " : "  ", fg: ink.good },
          {
            text: clip(listing.name, 30).padEnd(30),
            bold: cursor,
            fg: owned ? ink.good : undefined,
          },
          { text: " " },
          { text: listing.kind.padEnd(5), fg: SOURCE_INK[listing.kind] },
          { text: ` ${compact(listing.downloads).padStart(6)}  ` },
          dim(`${(listing.updated ?? "").slice(0, 10).padEnd(10)}  `),
          dim(listing.summary),
        ];
        return <Segs key={`${listing.ref}-${index}`} segs={clipSegs(segs, width)} />;
      })}
    </>
  );
}

function BrowseDetail({ browse, installed }: { browse: BrowseState; installed: Set<string> }) {
  const listing = selectedListing(browse);
  if (!listing) return <Line dim>enter opens a group · h/l folds · / searches</Line>;
  const details: AddonInfo | undefined = browse.info?.ref === listing.ref ? browse.info : undefined;
  const info: Listing = details ?? listing;
  const lines: Seg[][] = [
    [
      { text: info.name, bold: true },
      { text: "  " },
      { text: info.kind, fg: SOURCE_INK[info.kind] },
      dim(` ${info.ref.slice(info.kind.length + 1)}`),
      ...(installed.has(info.ref) ? [{ text: "  installed", fg: ink.good }] : []),
    ],
    [{ text: info.summary }],
    [
      dim("by "),
      { text: info.authors.join(", ") || "unknown" },
      dim("   downloads "),
      { text: compact(info.downloads) },
      dim("   updated "),
      { text: (info.updated ?? "unknown").slice(0, 10) },
      ...(details?.version ? [dim("   latest "), { text: details.version }] : []),
    ],
    [
      dim("flavors "),
      { text: info.flavors.join(", ") || "none tagged" },
      ...(info.categories.length
        ? [dim("   categories "), { text: info.categories.join(", ") }]
        : []),
    ],
  ];
  if (browse.infoLoading === listing.ref)
    lines.push([{ text: "loading details…", fg: ink.accent }]);
  else if (browse.infoError && !details) lines.push([{ text: browse.infoError, fg: ink.bad }]);
  else if (details?.changelog)
    lines.push([
      dim(`changelog ${details.changelog.version ?? ""}: `),
      { text: details.changelog.text.replace(/\s+/g, " ") },
    ]);
  else if (details) lines.push([dim(details.description.replace(/\s+/g, " "))]);
  else lines.push([dim("enter shows details and changelog · i installs")]);
  return (
    <>
      {DETAIL_PARTS.map((part, index) => (
        <Segs key={part} segs={lines[index] ?? []} />
      ))}
    </>
  );
}

const HELP: Record<View, [string, string][]> = {
  installed: [
    ["↑ ↓  j k", "move"],
    ["pgup pgdn", "move a page; ctrl-d and ctrl-u half a page; home and end to the ends"],
    ["u", "update the selected addon, or take over one installed outside wowaddon"],
    ["U", "update everything"],
    ["a", "add an addon: paste a GitHub, CurseForge or WoWInterface URL or ref"],
    ["x", "remove the selected addon's folders"],
    ["f", "switch between Classic Era and WoW: Forever"],
    ["r", "check for new versions"],
    ["tab", "browse and search for addons to install"],
    ["?  esc", "close this help"],
    ["q", "quit"],
  ],
  browse: [
    ["↑ ↓  j k", "move"],
    ["pgup pgdn", "move a page; ctrl-d and ctrl-u half a page; home and end to the ends"],
    ["/", "search by name or words"],
    ["o", "change the sort"],
    ["enter", "show details and the latest changelog, or open a group"],
    ["h l", "fold or unfold a group"],
    ["i", "install the selected addon"],
    ["n p", "next or previous page of results"],
    ["r", "search again"],
    ["f", "switch between Classic Era and WoW: Forever"],
    ["tab", "back to the installed addons"],
    ["?  esc", "close this help"],
    ["q", "quit"],
  ],
};

function HelpView({ view }: { view: View }) {
  return (
    <box flexDirection="column">
      {HELP[view].map(([keys, action]) => (
        <Segs key={keys} segs={[{ text: keys.padEnd(11), fg: ink.accent }, { text: action }]} />
      ))}
    </box>
  );
}

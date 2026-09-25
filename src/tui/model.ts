import { parseRef } from "../service";
import type { Flavor, Progress, Row, SourceKind } from "../types";

export type Mode = "list" | "add" | "remove-confirm" | "adopt-confirm" | "help";

export interface DetectedRef {
  kind: SourceKind;
  ref: string;
}

export interface TuiState {
  flavor: Flavor;
  addonsDir: string;
  rows: Row[];
  selected: number;
  mode: Mode;
  addInput: string;
  addDetected?: DetectedRef;
  addError?: string;
  confirmId?: string;
  progress: Record<string, Progress>;
  working: boolean;
  error?: string;
  notice?: string;
}

export function initState(flavor: Flavor, addonsDir: string, rows: Row[] = []): TuiState {
  return {
    flavor,
    addonsDir,
    rows,
    selected: 0,
    mode: "list",
    addInput: "",
    progress: {},
    working: false,
  };
}

function clampSelection(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

export function selectedRow(state: TuiState): Row | undefined {
  return state.rows[state.selected];
}

export function moveSelection(state: TuiState, delta: number): TuiState {
  if (state.mode !== "list") return state;
  return { ...state, selected: clampSelection(state.selected + delta, state.rows.length) };
}

export function setRows(state: TuiState, rows: Row[]): TuiState {
  return { ...state, rows, selected: clampSelection(state.selected, rows.length) };
}

export function setProgress(state: TuiState, progress: Progress): TuiState {
  if (["done", "skipped", "failed"].includes(progress.phase))
    return clearProgress(state, progress.id);
  return { ...state, progress: { ...state.progress, [progress.id]: progress } };
}

export function clearProgress(state: TuiState, id: string): TuiState {
  const progress = { ...state.progress };
  delete progress[id];
  return { ...state, progress };
}

export function setWorking(state: TuiState, working: boolean): TuiState {
  return { ...state, working, progress: working ? state.progress : {} };
}

export function setError(state: TuiState, error: string | undefined): TuiState {
  return { ...state, error, notice: undefined };
}

export function setNotice(state: TuiState, notice: string | undefined): TuiState {
  return { ...state, notice, error: undefined };
}

export function toggleHelp(state: TuiState): TuiState {
  return { ...state, mode: state.mode === "help" ? "list" : "help" };
}

export function openAdd(state: TuiState): TuiState {
  if (state.working) return state;
  return { ...state, mode: "add", addInput: "", addDetected: undefined, addError: undefined };
}

type ParseRef = (input: string) => DetectedRef;

function detect(input: string, parse: ParseRef): { detected?: DetectedRef; error?: string } {
  if (!input.trim()) return {};
  try {
    return { detected: parse(input) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function updateAddInput(
  state: TuiState,
  value: string,
  parse: ParseRef = parseRef,
): TuiState {
  if (state.mode !== "add") return state;
  const { detected, error } = detect(value, parse);
  return { ...state, addInput: value, addDetected: detected, addError: error };
}

export function cancelAdd(state: TuiState): TuiState {
  if (state.mode !== "add") return state;
  return { ...state, mode: "list", addInput: "", addDetected: undefined, addError: undefined };
}

export function openRemoveConfirm(state: TuiState): TuiState {
  if (state.working || state.mode !== "list") return state;
  const row = selectedRow(state);
  if (!row) return state;
  return { ...state, mode: "remove-confirm", confirmId: row.entry.id };
}

// What confirming a removal will do, in words: dev links and never-installed addons lose only their line.
export function removePrompt(row: Row): string {
  const name = row.entry.note ?? row.entry.ref;
  const folders = row.installed?.folders ?? [];
  if (row.status === "dev") return `stop tracking ${name}? its dev folder stays as it is · y/n`;
  if (!folders.length) return `stop tracking ${name}? · y/n`;
  return `remove ${name} and delete ${folders.join(", ")}? · y/n`;
}

export function openAdoptConfirm(state: TuiState): TuiState {
  if (state.working || state.mode !== "list") return state;
  const row = selectedRow(state);
  if (row?.status !== "unmanaged") return state;
  return { ...state, mode: "adopt-confirm", confirmId: row.entry.id };
}

export function cancelConfirm(state: TuiState): TuiState {
  if (state.mode !== "remove-confirm" && state.mode !== "adopt-confirm") return state;
  return { ...state, mode: "list", confirmId: undefined };
}

export function closeConfirm(state: TuiState): TuiState {
  return { ...state, mode: "list", confirmId: undefined };
}

export interface RowColumns {
  name: string;
  source: string;
  installed: string;
  latest: string;
  status: string;
}

export function rowColumns(row: Row, progress?: Progress): RowColumns {
  const name = row.entry.note ?? row.entry.ref;
  const status = progress && progress.phase !== "done" ? phaseLabel(progress) : statusLabel(row);
  return {
    name,
    source: row.entry.kind,
    installed: row.installed?.version ?? "",
    latest:
      row.latest && row.latest.version !== row.installed?.version ? `→ ${row.latest.version}` : "",
    status,
  };
}

function phaseLabel(progress: Progress): string {
  return progress.message ? `${progress.phase}: ${progress.message}` : progress.phase;
}

const STATUS_WORDS: Record<Row["status"], string> = {
  current: "up to date",
  update: "update available",
  missing: "not installed",
  unknown: "",
  dev: "dev link",
  unmanaged: "not managed · u takes it over",
  error: "failed",
};

function statusLabel(row: Row): string {
  return STATUS_WORDS[row.status];
}

// Pads each column to its widest cell so rows line up as a table; long names are cut with "…".
export function tableRows(columns: RowColumns[], keys: (keyof RowColumns)[]): string[] {
  const cell = (value: string, key: keyof RowColumns) =>
    key === "name" && value.length > NAME_MAX ? `${value.slice(0, NAME_MAX - 1)}…` : value;
  const widths = keys.map((key) => Math.max(0, ...columns.map((c) => cell(c[key], key).length)));
  return columns.map((c) =>
    keys
      .map((key, i) => cell(c[key], key).padEnd(widths[i]))
      .join("  ")
      .trimEnd(),
  );
}

const NAME_MAX = 28;

export function shortenPath(path: string, home: string): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export const FOOTER_HINT = "u update  U all  a add  x remove  f flavor  r refresh  ? help  q quit";

export const NARROW_WIDTH_COLUMNS = 80;

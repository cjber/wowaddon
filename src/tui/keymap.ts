import type { KeyEvent } from "@opentui/core";
import {
  type BrowseState,
  browseLines,
  cancelSearch,
  cursorLine,
  cursorTo,
  moveCursor,
  nextOrder,
  selectedListing,
  setFold,
  startSearch,
} from "./browse";
import {
  cancelAdd,
  cancelConfirm,
  closeConfirm,
  moveSelection,
  openAdd,
  openAdoptConfirm,
  openRemoveConfirm,
  selectedRow,
  switchView,
  type TuiState,
  toggleHelp,
  updateBrowse,
} from "./model";
import type { AddonActions, UpdateState } from "./useAddons";

export function handleKey(
  key: KeyEvent,
  state: TuiState,
  update: UpdateState,
  actions: AddonActions,
  onQuit: (code: number) => void,
  pageSize = 10,
) {
  if (key.ctrl && key.name === "c") {
    actions.abort();
    onQuit(130);
    return;
  }
  const typing = state.mode === "add" || state.browse.typing;
  if (key.name === "q" && (!typing || actions.busy)) {
    actions.abort();
    onQuit(0);
    return;
  }
  if (state.view === "browse" && state.browse.typing) {
    if (key.name === "escape") update((s) => updateBrowse(s, cancelSearch));
    return;
  }
  if (key.name === "tab") {
    update(switchView);
    const next = switchView(state);
    if (next.view === "browse" && !next.browse.loaded && !next.browse.loading)
      void actions.search(next.browse);
    return;
  }
  // Movement works while an install or sync runs; changes wait for it.
  const step = paging(key, pageSize);
  if (state.mode === "list" && step !== undefined) {
    if (state.view === "browse") update((s) => updateBrowse(s, (b) => moveBy(b, step)));
    else update((s) => moveSelection(s, step));
    return;
  }
  if (state.view === "browse" && state.mode === "list") {
    browseKey(key, state, update, actions);
    return;
  }
  if (actions.busy || state.working) return;
  if (state.mode === "add") {
    if (key.name === "escape") update(cancelAdd);
    return;
  }
  if (state.mode === "remove-confirm" || state.mode === "adopt-confirm") {
    if (key.sequence === "y" && state.confirmId) {
      if (state.mode === "remove-confirm") void actions.runRemove(state.confirmId);
      else {
        update(closeConfirm);
        void actions.runSync([state.confirmId], true);
      }
    } else if (key.name === "escape" || key.sequence === "n") update(cancelConfirm);
    return;
  }
  if (state.mode === "help") {
    if (key.name === "escape" || key.sequence === "?") update(toggleHelp);
    return;
  }
  if (key.sequence === "a") update(openAdd);
  else if (key.sequence === "x") update(openRemoveConfirm);
  else if (key.sequence === "f")
    void actions.loadContext(state.flavor === "era" ? "forever" : "era");
  else if (key.sequence === "r") void actions.refreshLatest();
  else if (key.sequence === "U") void actions.runSync();
  else if (key.sequence === "u") {
    const row = selectedRow(state);
    if (!row) return;
    if (row.status === "unmanaged") update(openAdoptConfirm);
    else void actions.runSync([row.entry.id]);
  } else if (key.sequence === "?") update(toggleHelp);
}

const END = Number.MAX_SAFE_INTEGER;
// j/k a row, pgup/pgdn a page, ctrl-d/u half a page, home/end the ends; undefined for any other key.
function paging(key: KeyEvent, pageSize: number): number | undefined {
  if (key.name === "up" || key.name === "k") return -1;
  if (key.name === "down" || key.name === "j") return 1;
  if (key.name === "pageup") return -pageSize;
  if (key.name === "pagedown") return pageSize;
  if (key.ctrl && key.name === "u") return -Math.max(1, Math.floor(pageSize / 2));
  if (key.ctrl && key.name === "d") return Math.max(1, Math.floor(pageSize / 2));
  if (key.name === "home") return -END;
  if (key.name === "end") return END;
  return undefined;
}
function moveBy(browse: BrowseState, step: number): BrowseState {
  if (step === -END) return cursorTo(browse, 0);
  if (step === END) return cursorTo(browse, browseLines(browse).length - 1);
  return moveCursor(browse, step);
}

function browseKey(key: KeyEvent, state: TuiState, update: UpdateState, actions: AddonActions) {
  const browse = state.browse;
  const query = (change: Partial<BrowseState>) => {
    const next = { ...browse, ...change };
    update((s) => updateBrowse(s, (b) => ({ ...b, ...change })));
    void actions.search(next);
  };
  if (key.sequence === "/") update((s) => updateBrowse(s, startSearch));
  else if (key.sequence === "?") update(toggleHelp);
  else if (key.name === "h" || key.name === "left")
    update((s) => updateBrowse(s, (b) => setFold(b, true)));
  else if (key.name === "l" || key.name === "right")
    update((s) => updateBrowse(s, (b) => setFold(b, false)));
  else if (key.sequence === "o") query({ order: nextOrder(browse), page: 1 });
  else if (key.sequence === "n" && browse.results.length) query({ page: browse.page + 1 });
  else if (key.sequence === "p" && browse.page > 1) query({ page: browse.page - 1 });
  else if (key.sequence === "r") query({});
  else if (key.name === "return") {
    if (cursorLine(browse)?.kind === "group")
      update((s) => updateBrowse(s, (b) => setFold(b, "toggle")));
    else {
      const listing = selectedListing(browse);
      if (listing) void actions.loadInfo(listing.ref);
    }
  } else if (key.sequence === "i") {
    const listing = selectedListing(browse);
    if (listing && !actions.busy && !state.working) void actions.runInstall(listing);
  } else if (key.sequence === "f" && !actions.busy && !state.working)
    void actions.loadContext(state.flavor === "era" ? "forever" : "era");
}

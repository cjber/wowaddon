import type { KeyEvent } from "@opentui/core";
import {
  cancelAdd,
  cancelConfirm,
  closeConfirm,
  moveSelection,
  openAdd,
  openAdoptConfirm,
  openRemoveConfirm,
  selectedRow,
  type TuiState,
  toggleHelp,
} from "./model";
import type { AddonActions, UpdateState } from "./useAddons";

export function handleKey(
  key: KeyEvent,
  state: TuiState,
  update: UpdateState,
  actions: AddonActions,
  onQuit: (code: number) => void,
) {
  if (key.ctrl && key.name === "c") {
    actions.abort();
    onQuit(130);
    return;
  }
  if (key.name === "q" && (state.mode !== "add" || actions.busy)) {
    actions.abort();
    onQuit(0);
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
  if (key.name === "up" || key.name === "k") update((s) => moveSelection(s, -1));
  else if (key.name === "down" || key.name === "j") update((s) => moveSelection(s, 1));
  else if (key.sequence === "a") update(openAdd);
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

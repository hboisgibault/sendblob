import { createSignal, Show } from "solid-js";
import {
  bwRecv,
  bwSend,
  fmtBytes,
  fmtSpeed,
  loadAdvanced,
  nodeId,
  storage,
} from "./state";

function CopyableId(props: { value: string }) {
  const [done, setDone] = createSignal(false);
  return (
    <span class="flex min-w-0 items-center gap-2">
      <span class="truncate font-mono" title={props.value}>
        {props.value}
      </span>
      <button
        class="shrink-0 text-xs text-accent underline decoration-dotted"
        onClick={() => {
          void navigator.clipboard.writeText(props.value);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        }}
      >
        {done() ? "copied" : "copy"}
      </button>
    </span>
  );
}

export function Advanced() {
  const [open, setOpen] = createSignal(false);
  const toggle = () => {
    const next = !open();
    setOpen(next);
    if (next) void loadAdvanced();
  };
  const storageText = () => {
    const s = storage();
    if (!s || !s.quota) return "…";
    const pct = ((s.usage / s.quota) * 100).toFixed(1);
    return `${fmtBytes(s.usage)} / ${fmtBytes(s.quota)} (${pct}%)`;
  };
  const bandwidthText = () => {
    const up = fmtSpeed(bwSend.mibps());
    const down = fmtSpeed(bwRecv.mibps());
    if (!up && !down) return "idle";
    return `▲ ${up || "0"} · ▼ ${down || "0"}`;
  };
  return (
    <div class="fixed inset-x-0 bottom-0 z-50">
      <Show when={open()}>
        <div class="mx-auto w-full max-w-2xl px-4 pb-2">
          <div class="panel pop-in flex flex-col gap-2.5 p-5 text-sm">
            <div class="flex min-w-0 items-center justify-between gap-4">
              <span class="shrink-0 font-pixel text-xs">NODE ID</span>
              <Show
                when={nodeId()}
                fallback={<span class="text-ink-soft">…</span>}
              >
                {(id) => <CopyableId value={id()} />}
              </Show>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span class="shrink-0 font-pixel text-xs">STORAGE</span>
              <span class="font-mono">{storageText()}</span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span class="shrink-0 font-pixel text-xs">BANDWIDTH</span>
              <span class="font-mono">{bandwidthText()}</span>
            </div>
          </div>
        </div>
      </Show>
      <div class="flex justify-center pb-3">
        <button class="btn-pixel px-4 py-2 text-xs" onClick={toggle}>
          {open() ? "▼ Hide stats" : "▲ Stats"}
        </button>
      </div>
    </div>
  );
}

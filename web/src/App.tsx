import { createSignal, For, Match, Show, Switch } from "solid-js";
import {
  bwRecv,
  bwSend,
  canShare,
  copyLink,
  doReceive,
  fileMeta,
  fmtBytes,
  fmtSpeed,
  incoming,
  link,
  nodeStatus,
  recvError,
  recvProgress,
  recvSaved,
  resetIncoming,
  resetSend,
  sendError,
  sendProgress,
  sendSelected,
  sendState,
  shareLink,
  startNode,
  statusMsg,
  copied,
  ticket,
} from "./state";
import { Qr } from "./Qr";

/** Segmented pixel progress bar. */
export function PixelBar(props: { done: number; total: number }) {
  const N = 24;
  const filled = () =>
    props.total > 0 ? Math.min(N, Math.round((props.done / props.total) * N)) : 0;
  return (
    <div class="pixelbar" role="progressbar">
      <For each={Array.from({ length: N }, (_, i) => i)}>
        {(i) => (
          <div
            classList={{
              seg: true,
              on: i < filled() && i < filled() - 1,
              "on-last": i === filled() - 1,
            }}
          />
        )}
      </For>
    </div>
  );
}

const GITHUB_URL = "https://github.com/hboisgibault/sendblob";

function GitHubIcon() {
  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="GitHub repository"
      title="GitHub"
      class="btn-pixel px-2.5 py-2"
    >
      <svg viewBox="0 0 16 16" class="size-6" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
    </a>
  );
}

function StatusPill() {
  return (
    <span
      id="node-status"
      data-state={nodeStatus()}
      class="panel flex items-center gap-2 px-3 py-2 text-xs font-pixel uppercase"
    >
      <span
        aria-hidden="true"
        class="inline-block size-2"
        classList={{
          "bg-accent blink": nodeStatus() === "connecting",
          "bg-good": nodeStatus() === "ready",
          "bg-ink": nodeStatus() === "error",
        }}
      />
      <Switch>
        <Match when={nodeStatus() === "connecting"}>Connecting…</Match>
        <Match when={nodeStatus() === "ready"}>Ready</Match>
        <Match when={nodeStatus() === "error"}>Offline</Match>
      </Switch>
    </span>
  );
}

function Dropzone() {
  let fileInput!: HTMLInputElement;
  const [drag, setDrag] = createSignal(false);
  const pick = (file: File | undefined | null) => {
    if (file) void sendSelected(file);
  };
  return (
      <div
      class="dropzone flex cursor-pointer flex-col items-center gap-4 px-6 py-16 text-center"
      classList={{ drag: drag() }}
      role="button"
      tabindex={0}
      aria-label="Drop a file or click to browse"
      onClick={() => fileInput.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") fileInput.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        pick(e.dataTransfer?.files?.[0]);
      }}
    >
      <div class="font-pixel text-5xl text-accent" aria-hidden="true">
        ▼▼▼
      </div>
      <div class="font-pixel text-2xl">Drop a file</div>
      <div class="text-base text-ink-soft">
        or click to browse — sent peer-to-peer, nothing is uploaded anywhere
      </div>
      <input
        id="file-input"
        ref={fileInput}
        type="file"
        class="hidden"
        onChange={(e) => {
          pick(e.currentTarget.files?.[0]);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}

function Sending() {
  const meta = () => fileMeta()!;
  return (
    <div class="panel pop-in flex flex-col gap-4 p-6">
      <div class="flex items-baseline justify-between gap-4">
        <span class="truncate font-pixel text-base">{meta().name}</span>
        <span class="shrink-0 text-base text-ink-soft">{fmtBytes(meta().size)}</span>
      </div>
      <PixelBar done={sendProgress().done} total={sendProgress().total} />
      <div class="flex justify-between font-mono text-sm text-ink-soft">
        <span>
          {fmtBytes(sendProgress().done)} / {fmtBytes(sendProgress().total)}
        </span>
        <Show when={bwSend.mibps() !== null}>{fmtSpeed(bwSend.mibps())}</Show>
      </div>
    </div>
  );
}

function ReadyToShare() {
  const meta = () => fileMeta()!;
  return (
    <div class="panel pop-in flex flex-col items-center gap-4 p-6">
      <div class="font-pixel text-xl text-good">■ Ready to share</div>
      <div class="flex items-baseline gap-2 text-base text-ink-soft">
        <span class="truncate font-bold text-ink">{meta().name}</span>
        <span>{fmtBytes(meta().size)}</span>
      </div>
      <div class="border-2 border-ink bg-paper-2 p-2 shadow-pixel-sm">
        <Qr text={link()} />
      </div>
      <div class="text-center text-sm text-ink-soft">
        scan to receive on a phone, or share the link
      </div>
      <div class="flex w-full flex-col gap-3 sm:flex-row">
        <Show
          when={canShare()}
          fallback={
            <button
              id="btn-copy-link"
              class="btn-pixel btn-pixel-primary flex-1"
              onClick={() => void copyLink()}
            >
              {copied() ? "Copied ✓" : "Copy link"}
            </button>
          }
        >
          <button
            id="btn-share"
            class="btn-pixel btn-pixel-primary flex-1"
            onClick={() => void shareLink()}
          >
            Share
          </button>
          <button id="btn-copy-link" class="btn-pixel flex-1" onClick={() => void copyLink()}>
            {copied() ? "Copied ✓" : "Copy link"}
          </button>
        </Show>
      </div>
      <button class="btn-pixel w-full text-sm" onClick={resetSend}>
        Send another file
      </button>
      {/* raw ticket, hidden (used by tooling) */}
      <span id="ticket-out" class="hidden" aria-hidden="true">
        {ticket() ?? ""}
      </span>
    </div>
  );
}

function SendError() {
  return (
    <div class="panel pop-in flex flex-col items-start gap-3 p-6">
      <div class="font-pixel text-base">Transfer failed</div>
      <p class="text-base break-all text-ink-soft">{sendError()}</p>
      <button class="btn-pixel btn-pixel-primary" onClick={resetSend}>
        Try again
      </button>
    </div>
  );
}

function SendView() {
  return (
    <Switch>
      <Match when={sendState() === "idle"}>
        <Dropzone />
      </Match>
      <Match when={sendState() === "importing"}>
        <Sending />
      </Match>
      <Match when={sendState() === "ready"}>
        <ReadyToShare />
      </Match>
      <Match when={sendState() === "error"}>
        <SendError />
      </Match>
    </Switch>
  );
}

function Incoming() {
  return (
    <Switch>
      <Match when={recvSaved()}>
        <div class="panel pop-in flex flex-col items-center gap-4 p-8 text-center">
          <div class="font-pixel text-2xl text-good">■ Received!</div>
          <p class="text-base text-ink-soft">
            saved as <span class="font-bold text-ink">{recvSaved()}</span>
          </p>
          <button class="btn-pixel btn-pixel-primary" onClick={resetIncoming}>
            Share a file too
          </button>
        </div>
      </Match>
      <Match when={recvError()}>
        <div class="panel pop-in flex flex-col items-start gap-3 p-6">
          <div class="font-pixel text-base">Download failed</div>
          <p class="text-base break-all text-ink-soft">{recvError()}</p>
          <p class="text-sm text-ink-soft">
            the sender must keep their tab open — then retry from the link
          </p>
          <div class="flex gap-2">
            <Show when={incoming()}>
              <button
                class="btn-pixel btn-pixel-primary"
                onClick={() => {
                  const inc = incoming();
                  if (inc) void doReceive(inc.ticket, inc.name);
                }}
              >
                Retry
              </button>
            </Show>
            <button class="btn-pixel" onClick={resetIncoming}>
              Back
            </button>
          </div>
        </div>
      </Match>
      <Match when={true}>
        <div class="panel pop-in flex flex-col gap-4 p-6">
          <div class="font-pixel text-xl">▼ Incoming file</div>
          <PixelBar done={recvProgress().done} total={recvProgress().total} />
          <div class="flex justify-between font-mono text-sm text-ink-soft">
            <span>{fmtBytes(recvProgress().done)}</span>
            <Show when={bwRecv.mibps() !== null}>{fmtSpeed(bwRecv.mibps())}</Show>
          </div>
        </div>
      </Match>
    </Switch>
  );
}

function PasteFallback() {
  const [open, setOpen] = createSignal(false);
  let ticketInput!: HTMLInputElement;
  const submit = () => {
    const t = ticketInput.value.trim();
    if (t) void doReceive(t);
  };
  return (
    <div class="flex flex-col items-center gap-2">
      <Show
        when={open()}
        fallback={
          <button class="text-sm text-ink-soft underline decoration-dotted hover:text-accent" onClick={() => setOpen(true)}>
            Paste a ticket instead
          </button>
        }
      >
        <div class="flex w-full items-stretch gap-2">
          <input
            id="ticket-in"
            ref={ticketInput}
            class="input-pixel text-sm"
            placeholder="blob://…"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            id="btn-receive"
            class="btn-pixel shrink-0 text-sm"
            disabled={nodeStatus() !== "ready"}
            onClick={submit}
          >
            Receive
          </button>
        </div>
      </Show>
    </div>
  );
}

export default function App() {
  void startNode();
  return (
    <div class="mx-auto flex min-h-full w-full max-w-2xl flex-col px-4">
      <div class="scanlines" aria-hidden="true" />
      <header class="flex items-center justify-between gap-4 pt-8 pb-6">
        <h1 class="font-pixel text-3xl tracking-tight">■ sendblob</h1>
        <div class="flex items-center gap-3">
          <GitHubIcon />
          <StatusPill />
        </div>
      </header>
      <main class="flex flex-1 flex-col gap-5 pb-6">
        <Show when={incoming()} fallback={<SendView />}>
          <Incoming />
        </Show>
      </main>
      <footer class="flex flex-col items-center gap-3 pb-24">
        <PasteFallback />
        <p class="text-center text-sm text-ink-soft">
          peer-to-peer transfers — when this tab closes, everything vanishes ·{" "}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="font-semibold text-accent underline decoration-dotted hover:text-accent-deep"
          >
            GitHub
          </a>
        </p>
      </footer>
      <span id="global-status" class="sr-only" aria-live="polite">
        {statusMsg()}
      </span>
    </div>
  );
}

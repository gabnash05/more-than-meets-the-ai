"use client";

import { createUuid } from "@/lib/uuid";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createRoomClient,
  loadRoomSession,
  clearRoomSession,
} from "@/features/room-client";
import type { AiGuessEvent, RoomClient, RoomSession, RoomSettings } from "@/contracts/room";
import { CRAYON_COLORS } from "@/contracts/player";
import {
  DEFAULT_DRAWING_SETTINGS,
  type CanvasStatus,
  type DrawingCanvasHandle,
  type DrawingBatcher,
} from "@/contracts/drawing";
import DrawingCanvas from "@/features/canvas/DrawingCanvas";
import { ReplayQueueOverflowError } from "@/features/canvas/replayQueue";
import { createDrawingBatcher } from "@/features/drawing-events";
import { Avatar } from "@/features/player/Avatar";
import { AiCard } from "./AiCard";
import { RoomFeedback } from "./RoomFeedback";
import { SavedSketch } from "./SavedSketch";
import { FinalResults, RoundRecap } from "./Results";
import "./room.css";

const emptyStatus: CanvasStatus = {
  canUndo: false,
  canRedo: false,
  busy: true,
  hasInk: false,
};
function Choice({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="room-setting">
      <span>{label}</span>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
function ChatMessages({ snapshot }: { snapshot: RoomSession["snapshot"] }) {
  const list = useRef<HTMLDivElement>(null);
  const latestId = snapshot.chat.at(-1)?.id;
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [latestId]);

  return (
    <div ref={list} className="room-messages" aria-live="polite">
      {snapshot.chat.length ? snapshot.chat.map(message => {
        const playerName = snapshot.players.find(player => player.id === message.playerId)?.profile.name ?? "Room";
        const correct = message.kind === "correct";
        return (
          <p key={message.id} className={correct ? "room-message-correct" : undefined}>
            <strong>{playerName}: </strong>
            {correct ? <><span aria-hidden="true">✓ </span>Correct!</> : message.text}
          </p>
        );
      }) : <p>Say hello to the room!</p>}
    </div>
  );
}
const numbers = (from: number, to: number, suffix: string) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    value: String(i + from),
    label: `${i + from} ${suffix}`,
  }));
export default function RoomScreen() {
  const router = useRouter(),
    search = useSearchParams(),
    code = search.get("code")?.trim().toUpperCase() ?? "";
  const [session, setSession] = useState<RoomSession | null>(null),
    [error, setError] = useState(""),
    [connection, setConnection] = useState("restoring"),
    [message, setMessage] = useState(""),
    [copyStatus, setCopyStatus] = useState(""),
    [settings, setSettings] = useState(DEFAULT_DRAWING_SETTINGS),
    [canvasStatus, setCanvasStatus] = useState(emptyStatus),
    [caughtUp, setCaughtUp] = useState(false),
    [clock, setClock] = useState(() => Date.now()),
    [clockOffset, setClockOffset] = useState(0),
    [streamVersion, setStreamVersion] = useState(0),
    [pendingDrawing, setPendingDrawing] = useState(0),
    [settingsPending, setSettingsPending] = useState(false),
    [settingsFailed, setSettingsFailed] = useState(false);
  const [guessPending, setGuessPending] = useState(false);
  const composer = useRef<HTMLInputElement>(null);
  const draftTurn = useRef<string | null>(null);
  const focusedTurns = useRef(new Set<string>());
  const screen = useRef<HTMLElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      const height = viewport?.height ?? window.innerHeight;
      screen.current?.style.setProperty("--room-viewport-height", `${height}px`);
      screen.current?.classList.toggle("keyboard-open", window.innerHeight - height > 120);
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => { viewport?.removeEventListener("resize", update); viewport?.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [session?.playerId]);
  const pendingGuess = useRef<{ canvasId: string; generation: number } | null>(null);
  const lifecycle = useRef(0);
  const [aiPulse, setAiPulse] = useState<AiGuessEvent>();
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 250); return () => clearInterval(timer); }, []);
  const client = useRef<RoomClient | null>(null),
    canvas = useRef<DrawingCanvasHandle>(null),
    batcher = useRef<DrawingBatcher | null>(null);
  const activeCanvas = useRef<{ id: string; generation: number } | null>(null);
  const seenAiJobs = useRef(new Set<string>());
  const aiPulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inviteCodeInput = useRef<HTMLInputElement>(null);
  const inviteLinkInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const saved = loadRoomSession();
    if (!code || !saved || saved.code !== code) {
      router.replace(code ? `/?code=${encodeURIComponent(code)}` : "/");
      return;
    }
    const c = createRoomClient();
    const lifecycleRef = lifecycle;
    client.current = c;
    let alive = true;
    let replayEpoch = 0;
    let recoveringReplay = false;
    const replayRecoveryMessage = "Drawing replay failed; restoring the authoritative canvas…";
    const unsubscribe = c.subscribe((event) => {
      if (!alive) return;
      if (event.type === "ai-guess") {
        const current = c.getSession()?.snapshot;
        if (seenAiJobs.current.has(event.jobId)) return;
        if (current?.phase !== "drawing" || current.game?.canvasId !== event.canvasId || current.game.generation !== event.generation || current.game.pause) return;
        if (current.settings.aiGuesserEnabled === false) return;
        seenAiJobs.current.add(event.jobId);
        setAiPulse(event);
        if (aiPulseTimer.current) clearTimeout(aiPulseTimer.current);
        aiPulseTimer.current = setTimeout(() => setAiPulse(undefined), 600);
      }
      if (event.type === "snapshot") {
        if (event.snapshot.serverTime !== undefined) setClockOffset(event.snapshot.serverTime - Date.now());
        const game = event.snapshot.game;
        const next = game ? { id: game.canvasId, generation: game.generation } : null;
        if (activeCanvas.current?.id !== next?.id || activeCanvas.current?.generation !== next?.generation) {
          replayEpoch++;
          recoveringReplay = false;
          lifecycle.current++;
          pendingGuess.current = null;
          setGuessPending(false);
          activeCanvas.current = next;
          seenAiJobs.current.clear();
          if (aiPulseTimer.current) clearTimeout(aiPulseTimer.current);
          setAiPulse(undefined);
          setPendingDrawing(0);
          setCaughtUp(false);
        }
        setSession((old) =>
          old
            ? {
                ...old,
                snapshot: event.snapshot,
                privateState: event.privateState,
              }
            : old,
        );
      }
      if (event.type === "drawing-queue") setPendingDrawing(event.pending);
      if (event.type === "gameplay" && event.name === "drawing-tail-discarded") { setError("Some drawing changes were not confirmed saved and could not be restored."); setStreamVersion(version => version + 1); }
      if (event.type === "connection") {
        setConnection(event.status);
        if (event.message === "Room session ended") {
          const current = loadRoomSession();
          if (current?.code === code && current.resumeToken === saved.resumeToken) clearRoomSession();
          setSession(null);
          setError(event.message);
        }
        if (event.status !== "connected") { replayEpoch++; recoveringReplay = false; lifecycle.current++; pendingGuess.current = null; setGuessPending(false); setCaughtUp(false); }
      }
      if (event.type === "drawing") {
        if (c.getSession()?.snapshot.phase === "interrupted") return;
        if (activeCanvas.current?.id !== event.canvasId || activeCanvas.current.generation !== event.generation) return;
        if (event.reset) { replayEpoch++; setCaughtUp(false); }
        const currentReplayEpoch = replayEpoch;
        const currentLifecycle = lifecycle.current;
        const replay = event.reset
          ? canvas.current?.hydrate(event.operations)
          : canvas.current?.applyOperations(event.operations);
        void replay
          ?.then(() => {
            if (alive && lifecycle.current === currentLifecycle && replayEpoch === currentReplayEpoch && activeCanvas.current?.id === event.canvasId && activeCanvas.current.generation === event.generation) {
              if (event.reset) {
                recoveringReplay = false;
                setError(previous => previous === replayRecoveryMessage ? "" : previous);
              }
              if (event.caughtUp && !recoveringReplay) setCaughtUp(true);
            }
          })
          .catch((error: unknown) => {
            if (!alive || lifecycle.current !== currentLifecycle || replayEpoch !== currentReplayEpoch || activeCanvas.current?.id !== event.canvasId || activeCanvas.current.generation !== event.generation) return;
            if (!recoveringReplay) {
              recoveringReplay = true;
              const recoveryEpoch = ++replayEpoch;
              setCaughtUp(false);
              if (!(error instanceof ReplayQueueOverflowError)) setError(replayRecoveryMessage);
              void c.resync().then(() => {
                // A shared resync may have emitted the very prefix that failed.
                // If no newer reset arrived, request one after that job settles.
                if (alive && replayEpoch === recoveryEpoch && recoveringReplay) return c.resync();
              }).catch(() => {
                if (alive && replayEpoch === recoveryEpoch) setError("Could not restore the drawing. Please retry.");
              });
            } else if (!(error instanceof ReplayQueueOverflowError && recoveringReplay && !event.reset)) {
              setCaughtUp(false);
              setError("Could not restore the drawing. Please retry.");
            }
          });
      }
    });
    c.resume(code, saved.resumeToken)
      .then((s) => {
        if (alive) {
          if (s.snapshot.serverTime !== undefined) setClockOffset(s.snapshot.serverTime - Date.now());
          const game = s.snapshot.game;
          activeCanvas.current = game ? { id: game.canvasId, generation: game.generation } : null;
          setSession(s);
          if (!s.snapshot.game) {
            const currentLifecycle = lifecycle.current;
            void c.resync().catch(e => { if (alive && lifecycle.current === currentLifecycle) setError(e instanceof Error ? e.message : "Could not restore this room."); });
          }
        }
      })
      .catch((e) => {
        if (alive) {
          setError(
            e instanceof Error ? e.message : "Could not restore this room.",
          );
          setConnection("disconnected");
        }
      });
    return () => {
      alive = false;
      lifecycleRef.current++;
      pendingGuess.current = null;
      if (aiPulseTimer.current) clearTimeout(aiPulseTimer.current);
      unsubscribe();
      c.dispose();
      client.current = null;
    };
  }, [code, router]);
  const snap = session?.snapshot,
    game = snap?.game,
    me = snap?.players.find((p) => p.id === session?.playerId),
    host = snap?.hostId === session?.playerId,
    role = session?.privateState?.role,
    drawing = snap?.phase === "drawing",
    result = snap?.phase === "result",
    choosing = snap?.phase === "choosing",
    paused = !!game?.pause,
    closing = game?.closing === true,
    promptsExhausted = snap?.startBlockers?.includes("Not enough unused prompts remain.") ?? false,
    teamDone = snap?.settings.mode === "team" && game?.teamProgress?.some(progress => progress.teamId === me?.teamId && (progress.status === "solved" || progress.status === "finished"));
  const activeGuess = drawing && !closing;
  const composerDisabled = connection !== "connected" || (activeGuess && (paused || !!teamDone || !!me?.solved || role !== "guesser"));
  useEffect(() => {
    if (!game) return;
    const turn = `${game.canvasId}:${game.generation}`;
    if (draftTurn.current !== turn) {
      if (draftTurn.current !== null) setMessage("");
      draftTurn.current = turn;
    }
    if (!activeGuess || composerDisabled || role !== "guesser" || focusedTurns.current.has(turn)) return;
    focusedTurns.current.add(turn);
    if (window.matchMedia("(max-width: 820px), (pointer: coarse)").matches || document.querySelector('[role="dialog"]')) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused !== composer.current) return;
    composer.current?.focus({ preventScroll: true });
  }, [game, activeGuess, composerDisabled, role]);
  const startSeconds = snap?.startDeadlineAt ? Math.max(0, Math.ceil((snap.startDeadlineAt - clock - clockOffset) / 1000)) : 3;
  const seconds = game?.pause ? Math.ceil(game.pause.remainingMs / 1000) : game?.deadlineAt ? Math.max(0, Math.ceil((game.deadlineAt - clock - clockOffset) / 1000)) : null;
  const displayTime = seconds === null ? game?.time ?? "--:--" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const refereeWarning = drawing && !paused && snap?.settings.aiRefereeEnabled !== false && game?.refereeWarning && game.refereeWarning.expiresAt > clock + clockOffset ? game.refereeWarning : undefined;
  useEffect(() => {
    if (!code || !game?.canvasId) return;
    const b = createDrawingBatcher({
      roomCode: code,
      streamId: createUuid(),
      canvasId: game.canvasId,
      generation: game.generation,
      transport: "room-client",
      send: (batch) => {
        const currentLifecycle = lifecycle.current;
        void client.current
          ?.submitDrawing(batch)
          .catch((e) => { if (lifecycle.current === currentLifecycle) setError(e.message); });
      },
    });
    batcher.current = b;
    return () => {
      b.dispose();
      batcher.current = null;
    };
  }, [code, game?.canvasId, game?.generation, streamVersion]);
  useEffect(() => {
    if (!game?.canvasId) return;
    const currentLifecycle = lifecycle.current;
    let current = true;
    if (snap?.phase === "interrupted") {
      void client.current?.getInterruptedSketch(game.canvasId, game.generation)
        .then(sketch => current && lifecycle.current === currentLifecycle ? canvas.current?.hydrate(sketch.operations) : undefined)
        .catch(() => { if (current && lifecycle.current === currentLifecycle) setError("Could not load the saved drawing."); });
    } else {
      void client.current?.resync().catch((e) => { if (current && lifecycle.current === currentLifecycle) setError(e instanceof Error ? e.message : "Could not restore the drawing."); });
    }
    return () => { current = false; };
  }, [game?.canvasId, game?.generation, snap?.phase]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]"))
        return;
      if (
        !drawing || paused || closing || teamDone ||
        role !== "drawer" ||
        !caughtUp ||
        connection !== "connected" ||
        canvasStatus.busy
      )
        return;
      const key = event.key.toLowerCase();
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        (key === "z" || key === "y")
      ) {
        event.preventDefault();
        if (key === "y" || event.shiftKey) canvas.current?.redo();
        else canvas.current?.undo();
      } else if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        ["b", "e", "f"].includes(key)
      )
        setSettings((s) => ({
          ...s,
          tool: ({ b: "brush", e: "eraser", f: "fill" } as const)[
            key as "b" | "e" | "f"
          ],
        }));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawing, paused, closing, teamDone, role, caughtUp, connection, canvasStatus.busy]);
  const getClient = useCallback(() => client.current, []);
  const action = useCallback(async (fn: () => Promise<void>) => {
    setError("");
    const currentLifecycle = lifecycle.current;
    try {
      await fn();
    } catch (e) {
      if (currentLifecycle !== lifecycle.current) return;
      setError(
        e instanceof Error
          ? e.message
          : "Something went wrong. Please try again.",
      );
    }
  }, []);
  function send(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    const roomClient = client.current;
    if (!text || !roomClient) return;
    if (composerDisabled) return;
    if (!activeGuess) {
      void action(async () => {
        await roomClient.sendChat(text);
        setMessage(current => current.trim() === text ? "" : current);
      });
      return;
    }
    if (!game || closing || paused || teamDone || me?.solved || connection !== "connected" || pendingGuess.current) return;
    // Claim synchronously so repeated Enter cannot race a React render.
    const token = { canvasId: game.canvasId, generation: game.generation };
    pendingGuess.current = token;
    setGuessPending(true);
    setError("");
    void roomClient.submitGuess(text).then(() => {
      if (pendingGuess.current === token) setMessage(current => current.trim() === text ? "" : current);
    }).catch((reason: unknown) => {
      if (pendingGuess.current === token) setError(reason instanceof Error ? reason.message : "Could not submit your guess.");
    }).finally(() => {
      if (pendingGuess.current !== token) return;
      pendingGuess.current = null;
      setGuessPending(false);
    });
  }
  function change(next: Partial<RoomSettings>) {
    if (!snap) return;
    setSettingsPending(true);
    setError("");
    void client.current!.updateSettings({ ...snap.settings, ...next })
      .then(() => setSettingsFailed(false))
      .catch((e: unknown) => {
        setSettingsFailed(true);
        setError(e instanceof Error ? e.message : "Could not update settings. Please try again.");
      })
      .finally(() => setSettingsPending(false));
  }
  async function copy(input: HTMLInputElement | null) {
    if (!input) return;
    let copied = false;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(input.value);
        copied = true;
      }
    } catch {
      // Clipboard permission can be denied even on HTTPS.
    }
    if (!copied) {
      input.focus();
      input.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        // Leave the selected text available for manual copying.
      }
    }
    setCopyStatus(copied ? "Copied!" : "Text selected. Copy it manually.");
  }
  if (!session || !snap || !me)
    return (
      <main className="room-loading">
        <h1>Getting your room ready…</h1>
        {error && (
          <p role="alert">
            {error}{" "}
            <button
              onClick={() => router.push(`/?code=${encodeURIComponent(code)}`)}
            >
              Return to entry
            </button>
          </p>
        )}
      </main>
    );
  const blockers =
    snap.startBlockers ??
    (snap.settings.mode === "individual"
      ? snap.players.filter((p) => p.connected).length < 2
        ? ["At least two connected players are needed."]
        : []
      : snap.teams
          .filter(
            (t) =>
              snap.players.filter((p) => p.connected && p.teamId === t.id)
                .length < 2,
          )
          .map((t) => `${t.name} needs at least two connected players.`));
  const link =
    typeof window !== "undefined"
      ? `${window.location.origin}/?code=${encodeURIComponent(code)}`
      : `/?code=${encodeURIComponent(code)}`;
  const roster = (teamId?: string) =>
    snap.players
      .filter((p) => snap.settings.mode === "individual" || p.teamId === teamId)
      .map((p) => (
        <div
          className={`room-person ${drawing && p.solved ? "is-solved" : ""}`}
          key={p.id}
        >
          <Avatar avatar={p.profile.avatar} />
          <span>
            <strong>
              {p.profile.name}
              {p.id === session.playerId ? " (you)" : ""}
            </strong>
            <small>
              {p.id === snap.hostId ? "Host · " : ""}
              {!p.connected
                ? "Disconnected"
                : drawing && p.solved
                  ? "Solved"
                  : drawing && game?.drawerId === p.id
                    ? "Drawing"
                    : "Connected"}
            </small>
          </span>
          {p.score !== undefined && <b>{p.score} pts</b>}
          {host && snap.phase === "lobby" && snap.settings.mode === "team" && (
            <Choice
              label={`Move ${p.profile.name}`}
              value={p.teamId ?? ""}
              options={snap.teams.map((t) => ({ value: t.id, label: t.name }))}
              onChange={(v) =>
                void action(() => client.current!.movePlayer(p.id, v))
              }
            />
          )}
        </div>
      ));
  return (
    <main ref={screen} className={`room-screen${snap.phase !== "lobby" ? " room-playing" : ""}`}>
      <header className="room-header">
        <div className="room-brand">
          <img src="/design/assets/more-than-meets-the-ai-icon.png" alt="" />
          <strong>
            More Than
            <br />
            Meets the AI
          </strong>
        </div>
        <Dialog>
          <DialogTrigger asChild>
            <button className="room-code">
              Room <strong>{code}</strong> ↗
            </button>
          </DialogTrigger>
          <DialogContent className="room-invite-dialog">
            <div className="room-invite-header">
              <DialogTitle>Invite your crew</DialogTitle>
              <DialogDescription>
                Share this code or link to invite someone.
              </DialogDescription>
            </div>
            <div className="room-invite-fields">
              <div className="room-invite-field">
                <label htmlFor="room-invite-code">Room code</label>
                <div className="room-invite-row">
                  <input
                    id="room-invite-code"
                    ref={inviteCodeInput}
                    readOnly
                    value={code}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button className="room-button" onClick={() => void copy(inviteCodeInput.current)}>
                    Copy code
                  </button>
                </div>
              </div>
              <div className="room-invite-field">
                <label htmlFor="room-invite-link">Room link</label>
                <div className="room-invite-row">
                  <input
                    id="room-invite-link"
                    ref={inviteLinkInput}
                    readOnly
                    value={link}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button className="room-button" onClick={() => void copy(inviteLinkInput.current)}>
                    Copy link
                  </button>
                </div>
              </div>
            </div>
            <div className="room-invite-footer">
              <p aria-live="polite">{copyStatus}</p>
              <DialogClose asChild>
                <button className="room-button room-invite-done">Done</button>
              </DialogClose>
            </div>
          </DialogContent>
        </Dialog>
        <div className="room-current">
          <span className="room-demo">{session.demo ? "Local demo" : ""}</span>
          <Avatar avatar={me.profile.avatar} />
          <strong>{me.profile.name}</strong>
          <Dialog>
            <DialogTrigger asChild>
              <button className="room-button" aria-label="Leave room">
                ↪
              </button>
            </DialogTrigger>
            <DialogContent className="room-action-dialog">
              <DialogTitle>Leave this room?</DialogTitle>
              <DialogDescription>
                Your seat will be released. If you are host, hosting transfers
                to another connected player; an empty room closes.
              </DialogDescription>
              <div className="room-modal-actions"><button
                className="room-button"
                onClick={() =>
                  void action(async () => {
                    await client.current!.leave();
                    clearRoomSession();
                    router.push("/");
                  })
                }
              >
                Leave room
              </button>
              <DialogClose asChild>
                <button className="room-button">Stay</button>
              </DialogClose></div>
            </DialogContent>
          </Dialog>
        </div>
      </header>
      {!!snap.interruptedSketches?.length && <Dialog>
        <DialogTrigger asChild><button className="room-button">View saved drawings</button></DialogTrigger>
        <DialogContent>
          <DialogTitle>Saved drawings</DialogTitle>
          <DialogDescription>These drawings show the saved portion of interrupted rounds.</DialogDescription>
          {snap.interruptedSketches.map(sketch => <section key={`${sketch.canvasId}:${sketch.generation}`}><h3>Interrupted drawing</h3><SavedSketch getClient={getClient} canvasId={sketch.canvasId} generation={sketch.generation} /></section>)}
        </DialogContent>
      </Dialog>}
      {error && (
        <p className="room-error" role="alert">
          {error}
        </p>
      )}
      {!!snap.hostDisconnectedUntil && <p className="room-error" role="status">Host reconnecting. Hosting is reserved briefly before transfer.</p>}
      {drawing && teamDone && <p className="room-error" role="status">Your team has finished. Waiting for the other teams.</p>}
      {paused && <p className="room-error" role="status">Turn paused while {game?.pause?.reason === "drawer-disconnected" ? "the drawer reconnects" : "guessers reconnect"}.</p>}
      {game?.saving === "blocked" && <p className="room-error" role="status">Saving is delayed. Waiting for the room service.</p>}
      {drawing && game && !snap.players.find(p => p.id === game.drawerId)?.connected && <p className="room-error" role="status">The drawer disconnected. Their drawing remains visible.</p>}
      {(connection !== "connected" || (drawing && !caughtUp)) && (
        <p className="room-error" role="status">
          {connection === "restoring" || (drawing && !caughtUp)
            ? "Restoring your room and drawing…"
            : "Connection interrupted. Reconnect to continue."}{" "}
          {connection !== "connected" && (
            <button
              className="room-button"
              onClick={() => void action(() => client.current!.resync())}
            >
              Retry
            </button>
          )}
        </p>
      )}
      {snap.phase === "lobby" ? (
        <div className="lobby-layout">
          <section>
            <div className="lobby-heading">
              <div>
                <p className="room-eyebrow">YOUR PRIVATE ROOM</p>
                <h1>Get the crew together.</h1>
                <p>
                  Invite players, choose your settings, and get ready to draw.
                </p>
              </div>
            </div>
            <section className="room-panel room-roster">
              <h2>
                {snap.settings.mode === "individual"
                  ? "Everyone vs AI"
                  : "Players"}
              </h2>
              {snap.settings.mode === "individual"
                ? roster()
                : snap.teams.map((t) => (
                    <div className="room-team-block" key={t.id}>
                      <h3>{t.name}</h3>
                      {roster(t.id)}
                      {me.teamId !== t.id && (
                        <button
                          className="room-button"
                          onClick={() =>
                            void action(() => client.current!.selectTeam(t.id))
                          }
                        >
                          Join team
                        </button>
                      )}
                    </div>
                  ))}
            </section>
            <section className="room-panel room-chat room-lobby-chat">
              <h2>Room chat</h2>
              <ChatMessages snapshot={snap} />
              <form onSubmit={send}>
                <input
                  aria-label="Message the room"
                  placeholder="Message the room…"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  maxLength={240}
                />
                <button className="room-button">Send</button>
              </form>
            </section>
          </section>
          <aside>
            <section className="room-panel room-settings">
              <h2>Room settings</h2>
              {host ? (
                <>
                  <Choice
                    disabled={settingsPending}
                    label="Mode"
                    value={snap.settings.mode}
                    options={[
                      { value: "individual", label: "Individual" },
                      { value: "team", label: session.demo ? "Team" : "Team (coming later)", disabled: !session.demo },
                    ]}
                    onChange={(v) =>
                      change({ mode: v as RoomSettings["mode"] })
                    }
                  />
                  {snap.settings.mode === "individual" ? (
                    <Choice
                      disabled={settingsPending}
                      label="Player seats"
                      value={String(snap.settings.seats)}
                      options={numbers(2, 8, "seats")}
                      onChange={(v) => change({ seats: Number(v) })}
                    />
                  ) : (
                    <>
                      <Choice
                        disabled={settingsPending}
                        label="Teams"
                        value={String(snap.settings.teamCount)}
                        options={numbers(2, 4, "teams")}
                        onChange={(v) => change({ teamCount: Number(v) })}
                      />
                      <Choice
                        disabled={settingsPending}
                        label="Seats per team"
                        value={String(snap.settings.seatsPerTeam)}
                        options={numbers(2, 8, "seats")}
                        onChange={(v) => change({ seatsPerTeam: Number(v) })}
                      />
                    </>
                  )}
                  <Choice
                    disabled={settingsPending}
                    label="Prompt rounds"
                    value={String(snap.settings.rounds)}
                    options={numbers(1, 20, "rounds")}
                    onChange={(v) => change({ rounds: Number(v) })}
                  />
                  <fieldset className="room-ai-settings" disabled={settingsPending}>
                    <legend>AI features</legend>
                    <label><input type="checkbox" aria-label="Enable AI Guesser" checked={snap.settings.aiGuesserEnabled !== false} onChange={e => change({ aiGuesserEnabled: e.currentTarget.checked })} /> AI Guesser</label>
                    <label><input type="checkbox" aria-label="Enable AI Referee" checked={snap.settings.aiRefereeEnabled !== false} onChange={e => change({ aiRefereeEnabled: e.currentTarget.checked })} /> AI Referee</label>
                  </fieldset>
                </>
              ) : (
                <p>
                  {snap.settings.mode === "individual"
                    ? `Individual · ${snap.settings.seats} seats`
                    : `Team · ${snap.settings.teamCount} teams · ${snap.settings.seatsPerTeam} seats per team`}
                  <br />
                  {snap.settings.rounds} prompt rounds
                </p>
              )}
              {blockers.map((b) => (
                <p className="room-blocker" key={b}>
                  {b}
                </p>
              ))}
              <button
                className="room-primary room-desktop-start"
                disabled={
                  !host || settingsPending || settingsFailed || blockers.length > 0 || connection !== "connected"
                }
                onClick={() => void action(() => client.current!.start())}
              >
                {host ? "Start match →" : `Waiting for ${snap.players.find(p => p.id === snap.hostId)?.profile.name ?? "host"}`}
              </button>
            </section>
            <section className="room-panel">
              <h2>How this room plays</h2>
              <p>
                {snap.settings.mode === "individual"
                  ? "Each guesser earns personal speed points. The drawer earns recognition when people solve the drawing."
                  : "Work together for shared team points. Teams draw on separate canvases."}
              </p>
              {!session.demo && <p>AI guesses are scored separately from human points.</p>}
              <p>Drawers rotate each prompt round. No written answer clues.</p>
            </section>
          </aside>
          <div className="room-mobile-start">
            {blockers.map((blocker) => <p key={blocker}>{blocker}</p>)}
            <button className="room-primary" disabled={!host || settingsPending || settingsFailed || blockers.length > 0 || connection !== "connected"} onClick={() => void action(() => client.current!.start())}>
              {host ? "Start match →" : `Waiting for ${snap.players.find(p => p.id === snap.hostId)?.profile.name ?? "host"}`}
            </button>
          </div>
        </div>
      ) : (
        <div className="room-layout">
          <p className="room-phase-announcement" role="status">{snap.phase === "starting" ? "Match starting" : choosing ? "Word selection" : drawing ? closing ? "Round complete. Preparing results" : role === "drawer" ? "Your role: drawer" : "Your role: guesser" : result ? "Round results" : snap.phase === "finished" ? "Match complete" : "Round interrupted"}</p>
          <aside className="room-teams">
            <section className="room-panel">
              <h2>
                {snap.settings.mode === "individual"
                  ? "Everyone vs AI"
                  : "Players"}
              </h2>
              {roster(me.teamId)}
            </section>
            {snap.settings.mode === "team" && snap.teams.filter(t => t.id !== me.teamId).map(t => <section className="room-panel" key={t.id}><h2>{t.name}</h2><p>{game?.teamProgress?.find(progress => progress.teamId === t.id)?.status ?? (snap.players.some(p => p.teamId === t.id && p.solved) ? "Solved" : "Still guessing")}</p></section>)}
          </aside>
          <section className="room-drawing">
            {!result && snap.phase !== "finished" && <><div className="room-round"><h2>Round {game?.round ?? "–"} / {snap.settings.rounds}</h2><span>{snap.settings.mode === "team" ? "Team play" : snap.settings.aiGuesserEnabled === false ? "Individual play" : "Everyone vs AI"}</span></div>
            <div className="room-prompt">
              <div>
                <span className="room-eyebrow">{snap.phase === "starting" ? "Match starting" : choosing ? "Choosing a word" : role === "drawer" ? "You are drawing" : "Guess the drawing"}</span>
                <strong>{choosing ? (session.privateState?.promptOptions?.length ? "Pick a word below" : `${snap.players.find(p => p.id === (game?.choosingPlayerId ?? game?.drawerId))?.profile.name ?? "The drawer"} is choosing`) : role === "drawer" ? session.privateState?.target : game?.hint}</strong>
              </div>
              <div className="room-time"><span>Time</span><strong>{displayTime}</strong></div>
            </div>
            </>}
            {snap.phase === "finished" && <FinalResults snapshot={snap} playerId={session.playerId} host={!!host} onReturn={() => void action(() => client.current!.returnToLobby())} />}
            {result && game?.result && <RoundRecap snapshot={snap} playerId={session.playerId} seconds={seconds} onReturn={() => void action(() => client.current!.returnToLobby())} />}
            <div className={`room-board${refereeWarning ? " room-board-warning" : ""}`} hidden={snap.phase === "finished"}>
              {refereeWarning && <div className="room-referee-warning" role="status" data-testid="referee-warning"><strong>Writing detected by referee</strong><span>{Math.round(refereeWarning.confidence * 100)}% confidence</span></div>}
              <DrawingCanvas
                ref={canvas}
                readOnly={
                  !drawing || paused || closing || teamDone ||
                  role !== "drawer" ||
                  connection !== "connected" ||
                  !caughtUp
                }
                settings={settings}
                onOperation={(op) => batcher.current?.enqueue(op)}
                onStatusChange={status => {
                  if (role !== "drawer") return;
                  setCanvasStatus(previous => previous.canUndo === status.canUndo && previous.canRedo === status.canRedo && previous.busy === status.busy && previous.hasInk === status.hasInk ? previous : status);
                }}
                onError={setError}
              />
            {snap.phase === "starting" && <section className="room-panel room-result-overlay" aria-label="Match countdown"><h2>Get ready!</h2><strong className="room-countdown">{startSeconds || "Starting…"}</strong><p>Word selection starts next.</p></section>}
            {choosing && <section className="room-panel room-result-overlay"><h2>{session.privateState?.promptOptions?.length ? "Choose a word" : "Waiting for the drawer"}</h2><div className="room-modal-actions">{session.privateState?.promptOptions?.map(option => <button className="room-button" key={option.id} onClick={() => void action(() => client.current!.choosePrompt(option.id))}>{option.label}</button>)}</div></section>}
            {snap.phase === "interrupted" && <section className="room-panel room-result-overlay"><h2>Round interrupted</h2><p>The drawing saved for this session is available to review.</p>{promptsExhausted ? <p>Not enough unused prompts remain.</p> : <p>Retry this round with a fresh word.</p>}{host ? <><div className="room-modal-actions">{!promptsExhausted && <button className="room-button" onClick={() => void action(() => client.current!.retryInterrupted())}>Retry round</button>}{snap.canReturnToLobby && <><p>Returning ends this match; prior results are saved for this session.</p><button className="room-button" onClick={() => void action(() => client.current!.returnToLobby())}>Return to lobby</button></>}</div></> : <p>Waiting for the host to retry or return to the lobby.</p>}</section>}
            </div>
            {game?.sync && !result && snap.phase !== "finished" && <p role="status">{pendingDrawing > 0 ? "Drawing changes queued on this device; waiting for the room service. " : ""}{game.sync.sequence === 0 ? "Canvas ready" : game.sync.durableSequence < game.sync.sequence ? "Server received drawing; saving…" : "Server-received drawing saved for this session"}</p>}
            {drawing && role === "drawer" && (
              <fieldset
                className="room-tools"
                disabled={
                  !caughtUp || paused || closing || teamDone || connection !== "connected" || canvasStatus.busy
                }
              >
                <div className="room-tool-row">
                  {(["brush", "eraser", "fill"] as const).map((tool) => (
                    <button
                      key={tool}
                      className="room-button"
                      aria-pressed={settings.tool === tool}
                      onClick={() => setSettings((s) => ({ ...s, tool }))}
                    >
                      {tool}
                    </button>
                  ))}
                  <button
                    className="room-button"
                    disabled={!canvasStatus.canUndo}
                    onClick={() => canvas.current?.undo()}
                  >
                    Undo
                  </button>
                  <button
                    className="room-button"
                    disabled={!canvasStatus.canRedo}
                    onClick={() => canvas.current?.redo()}
                  >
                    Redo
                  </button>
                  <button
                    className="room-button"
                    disabled={!canvasStatus.hasInk}
                    onClick={() => canvas.current?.clear()}
                  >
                    Clear
                  </button>
                </div>
                <div className="room-tool-row room-palette">
                  {["#181321", ...Object.values(CRAYON_COLORS), "#FFFFFF"].map(
                    (color) => (
                      <button
                        key={color}
                        aria-label={`Color ${color}`}
                        aria-pressed={settings.color.toUpperCase() === color}
                        style={{ background: color }}
                        onClick={() => setSettings((s) => ({ ...s, color }))}
                      />
                    ),
                  )}
                  <label>
                    Size{" "}
                    <input
                      type="range"
                      min="2"
                      max="40"
                      value={settings.size}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          size: Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    Custom color{" "}
                    <input
                      type="color"
                      value={settings.color}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, color: e.target.value }))
                      }
                    />
                  </label>
                </div>
              </fieldset>
            )}
          </section>
          <aside className="room-chat-column">
            {snap.phase !== "finished" && <AiCard disabled={snap.settings.aiGuesserEnabled === false} game={game} result={result} pulse={drawing && !paused ? aiPulse : undefined} unavailable={game?.result?.aiBenchmark?.status === "unavailable" || (!session.demo && game?.aiStatus === "unavailable")} />}
            <div className="room-chat-order">
              <section
                data-testid="room-chat"
                className={`room-panel room-chat ${me.solved ? "is-solved" : ""}`}
              >
                <h2>
                  {activeGuess && role === "guesser" ? "Your guesses" : "Room chat"}
                </h2>
                <ChatMessages snapshot={snap} />
                <RoomFeedback phase={snap.phase} role={role} pending={guessPending} solved={me.solved} closing={closing} saving={game?.saving} paused={paused} />
                <form onSubmit={send}>
                  <input
                    ref={composer}
                    aria-label={
                      activeGuess && role === "guesser"
                        ? "Your guess"
                        : "Message the room"
                    }
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={
                      composerDisabled
                    }
                    placeholder={
                      activeGuess && role === "guesser"
                        ? "Type your guess…"
                        : "Say something…"
                    }
                  />
                  <button
                    className="room-button"
                    disabled={
                      composerDisabled || guessPending
                    }
                  >
                    Send
                  </button>
                </form>
              </section>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

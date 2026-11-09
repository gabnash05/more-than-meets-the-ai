"use client";

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CRAYON_COLORS,
  DEFAULT_AVATAR,
  type AvatarConfig,
  type AvatarShape,
  type AvatarExpression,
  type CrayonColor,
} from "../../contracts/player";
import { Avatar } from "./Avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { readPlayerProfile, savePlayerProfile } from "./profile";
import { createRoomClient, saveRoomSession } from "@/features/room-client";
import "./player.css";

const shapes: AvatarShape[] = ["pebble", "droplet", "spark", "bean", "cloud"];
const expressions: AvatarExpression[] = [
  "smile",
  "wink",
  "wow",
  "grin",
  "sleepy",
];
const colors = Object.keys(CRAYON_COLORS) as CrayonColor[];
const pick = <T,>(items: T[]): T =>
  items[Math.floor(Math.random() * items.length)];
const title = (s: string) => s[0].toUpperCase() + s.slice(1);

type BobStyle = CSSProperties & {
  "--bob-duration": string;
  "--bob-delay": string;
  "--bob-lift": string;
};
export default function LoginScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<AvatarConfig>(DEFAULT_AVATAR);
  const [room, setRoom] = useState(params.get("code") ?? "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [editDestination, setEditDestination] = useState(false);
  const invited = Boolean(params.get("code")) && !editDestination;
  const [motion, setMotion] = useState<BobStyle[]>([]);
  useEffect(() => {
    const profile = readPlayerProfile();
    // Browser storage is only available after the static page hydrates.
    if (profile) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(profile.name);
      setAvatar(profile.avatar);
    }
    // Randomize only after hydration to keep server and client markup consistent.
    setMotion(
      [0, 1, 2].map((i) => ({
        "--bob-duration": `${2.5 + i * 0.5 + Math.random() * 0.4}s`,
        "--bob-delay": `${[-1.3, -2.1, -0.7, -1.8][i]}s`,
        "--bob-lift": `${[-6, -10, -8, -7][i]}px`,
      })),
    );
  }, []);
  async function enter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const joining = submitter?.value === "join";
    const cleanName = name.trim();
    const cleanRoom = room.trim();
    if (!cleanName || cleanName.length > 24) {
      setError("Please enter a name of 1–24 characters.");
      return;
    }
    if (joining && !cleanRoom) {
      setError("Please enter a room code.");
      return;
    }
    const profile = { name: cleanName, avatar };
    savePlayerProfile(profile);
    setPending(true);
    setError("");
    try {
      const client = createRoomClient();
      const session = joining
        ? await client.join(cleanRoom.toUpperCase(), profile)
        : await client.create(profile);
      saveRoomSession(session);
      client.dispose();
      router.push(`/room/?code=${encodeURIComponent(session.snapshot.code)}`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not enter the room. Please try again.",
      );
      setPending(false);
    }
  }
  function randomize() {
    let next: AvatarConfig;
    do {
      next = {
        shape: pick(shapes),
        expression: pick(expressions),
        color: pick(colors),
      };
    } while (
      next.shape === avatar.shape &&
      next.expression === avatar.expression &&
      next.color === avatar.color
    );
    setAvatar(next);
  }
  return (
    <main className="player-login">
      <header className="player-header">
        <img src="/design/assets/more-than-meets-the-ai-icon.png" alt="" />
        <strong>More Than<br />Meets the AI</strong>
      </header>
      <div className="player-login-content">
        <section className="player-art">
          <div className="player-crew" aria-hidden="true">
            <div className="player-bob" style={motion[0]}><Avatar avatar={{ shape: "spark", expression: "wink", color: "pink" }} /></div>
            <div className="player-bob" style={motion[1]}><Avatar avatar={{ shape: "pebble", expression: "smile", color: "cyan" }} /></div>
            <div className="player-bob" style={motion[2]}><Avatar avatar={{ shape: "droplet", expression: "wow", color: "green" }} /></div>
          </div>
          <h1>Your imagination wasn’t in its training data.</h1>
          <span className="player-pill">Draw together. Outsmart the AI.</span>
        </section>
        <form className="player-form" onSubmit={enter} noValidate>
          <div>
            <p className="player-eyebrow">{invited ? "You’re invited" : "Who’s playing?"}</p>
            <h2>{invited ? "Your crew is waiting." : "Make yourself at home."}</h2>
          </div>
          {invited && <p className="player-invite">Join room <strong>{room}</strong></p>}
          <label className="player-field">
            Your name
            <input value={name} onChange={(e) => { setName(e.target.value); setError(""); }} maxLength={24} autoComplete="nickname" placeholder="What should we call you?" />
          </label>
          <div className="player-editor">
            <Avatar avatar={avatar} label="Your paint character preview" />
            <div className="player-editor-controls">
              <label className="player-field">Shape
                <Select value={avatar.shape} onValueChange={(shape) => setAvatar({ ...avatar, shape: shape as AvatarShape })}>
                  <SelectTrigger aria-label="Shape"><SelectValue /></SelectTrigger>
                  <SelectContent>{shapes.map(shape => <SelectItem key={shape} value={shape}>{title(shape)}</SelectItem>)}</SelectContent>
                </Select>
              </label>
              <label className="player-field">Face
                <Select value={avatar.expression} onValueChange={(expression) => setAvatar({ ...avatar, expression: expression as AvatarExpression })}>
                  <SelectTrigger aria-label="Face"><SelectValue /></SelectTrigger>
                  <SelectContent>{expressions.map(expression => <SelectItem key={expression} value={expression}>{title(expression)}</SelectItem>)}</SelectContent>
                </Select>
              </label>
              <div className="player-colors" aria-label="Character color">
                {colors.map(color => <button key={color} type="button" className="player-color" style={{ background: CRAYON_COLORS[color] }} aria-label={`${title(color)} character`} aria-pressed={avatar.color === color} onClick={() => setAvatar({ ...avatar, color })} />)}
              </div>
              <button type="button" className="player-mix" onClick={randomize}>Mix it up ↻</button>
            </div>
          </div>
          {error && <p className="player-error" role="alert">{error}</p>}
          {invited ? <>
            <button className="player-button player-create" type="submit" value="join" disabled={pending}>{pending ? "Entering room…" : "Join room →"}</button>
            <button className="player-mix" type="button" onClick={() => setEditDestination(true)}>Use a different code</button>
          </> : <>
            <button className="player-button player-create" type="submit" value="create" disabled={pending}>{pending ? "Entering room…" : "Create a room →"}</button>
            <div className="player-divider" />
            <div className="player-join">
              <label className="player-field">Already got a code?
                <input value={room} onChange={(e) => { setRoom(e.target.value); setError(""); }} placeholder="ABC234" maxLength={32} autoCapitalize="characters" autoComplete="off" />
              </label>
              <button className="player-button player-join-button" type="submit" value="join" disabled={pending}>Join room</button>
            </div>
          </>}
        </form>
      </div>
    </main>
  );
}

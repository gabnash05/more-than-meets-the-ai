"use client";
import { useRouter } from "next/navigation";
import { saveRoomSession } from "@/features/room-client";
import { seedReviewScenario } from "@/features/room-client/review";

const scenarios = [
  ["lobby", "Lobby · host"],
  ["drawer", "Drawing · drawer"],
  ["guesser", "Drawing · guesser"],
  ["result-correct", "Result · correct"],
  ["result-missed", "Result · missed"],
  ["benchmark-recap-positive", "Synthetic AI recap · solved"],
  ["benchmark-recap-zero", "Synthetic AI recap · not solved"],
  ["benchmark-recap-unavailable", "Synthetic AI recap · unavailable"],
  ["benchmark-final-positive", "Synthetic AI final · positive"],
  ["benchmark-final-zero", "Synthetic AI final · zero"],
  ["benchmark-final-unavailable", "Synthetic AI final · unavailable"],
  ["standings-2", "Synthetic standings · 2 players"],
  ["standings-4", "Synthetic standings · 4 players"],
  ["standings-5", "Synthetic standings · 5 players"],
  ["standings-6", "Synthetic standings · 6 players"],
  ["standings-7", "Synthetic standings · 7 players"],
  ["standings-eight", "Synthetic standings · eight and ties"],
  ["standings-zero", "Synthetic standings · all zero"],
  ["chat-cap", "Synthetic chat · 100 messages"],
  ["chat-cap-active", "Synthetic active chat · 100 messages"],
  ["exhausted-interrupted", "Synthetic exhaustion · interrupted host"],
  ["exhausted-guest", "Synthetic exhaustion · interrupted guest"],
  ["exhausted-result", "Synthetic exhaustion · recap host"],
  ["restoring", "Restoring"],
  ["drawer-away", "Drawer disconnected"],
  ["ai-guessing", "AI · guessing"],
  ["ai-wrong", "AI · wrong"],
  ["ai-correct", "AI · correct"],
  ["team-minimum", "Team minimum blocker"],
  ["host-recovery", "Host recovery"],
  ["host-transfer", "Host transfer"],
  ["invite-full", "Invitation · full"],
  ["invite-not-found", "Invitation · not found"],
  ["invite-in-progress", "Invitation · in progress"],
] as const;
export default function ReviewPage() {
  const router = useRouter();
  return (
    <main
      style={{
        padding: "2rem",
        display: "grid",
        gap: "1rem",
        justifyItems: "start",
      }}
    >
      <h1>Local room review</h1>
      <p>These controls seed simulated room states for review.</p>
      {scenarios.map(([scenario, label]) => (
        <button
          className="room-button"
          key={scenario}
          onClick={async () => {
            const session = await seedReviewScenario(scenario);
            if (scenario.startsWith("invite-")) {
              router.push(`/?code=${encodeURIComponent(session.snapshot.code)}`);
            } else {
              saveRoomSession(session);
              router.push(`/room/?code=${encodeURIComponent(session.snapshot.code)}`);
            }
          }}
        >
          {label}
        </button>
      ))}
    </main>
  );
}

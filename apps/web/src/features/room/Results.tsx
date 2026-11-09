import { Trophy } from "lucide-react";
import type { RoomSnapshot } from "@/contracts/room";
import { Avatar } from "@/features/player/Avatar";

const labels: Record<string, string> = {
  guesserBase: "Guess points",
  aiAdjustment: "AI adjustment",
  drawerRecognition: "Drawing recognition",
  drawerBonus: "Beat-the-AI bonus",
};

type ResultProps = {
  snapshot: RoomSnapshot;
  playerId: string;
  onReturn: () => void;
};

export function RoundRecap({ snapshot, playerId, seconds, onReturn }: ResultProps & { seconds: number | null }) {
  const result = snapshot.game!.result!;
  const me = snapshot.players.find(player => player.id === playerId);
  const scoreId = snapshot.settings.mode === "team" ? me?.teamId ?? "" : playerId;
  const points = result.deltas[scoreId] ?? 0;
  const ai = result.aiBenchmark;
  const nextDrawer = snapshot.players.find(player => player.id === result.nextDrawerId);
  const countdown = seconds ?? result.countdown;
  const components = Object.entries(result.components?.[playerId] ?? {}).filter(
    ([key, value]) => value !== undefined && !((key === "aiAdjustment" || key === "drawerBonus") && value === 0),
  );
  const gainRows = snapshot.settings.mode === "team"
    ? snapshot.teams.map(team => ({ id: team.id, name: team.name }))
    : snapshot.players.filter(player => player.id !== playerId).map(player => ({ id: player.id, name: player.profile.name }));
  const aiLabel = ai?.status === "solved"
    ? `Solved · ${ai.points} points`
    : ai?.status === "unsolved" ? `Not solved · ${ai.points} points` : "Unavailable";

  return (
    <section className="room-panel room-results room-recap" aria-label="Round recap">
      <p className="room-eyebrow">Round complete</p>
      <h2>{me?.solved ? "You got it!" : "Round complete"}</h2>
      <div className="room-recap-highlights">
        <p className="room-recap-word"><span>The word was</span><strong>{result.word}</strong></p>
        <p className="room-recap-score"><span>Your round:</span><strong>{points} points</strong></p>
      </div>
      <div className="room-result-details">
        {components.map(([key, value]) => <p key={key}>{labels[key] ?? key}: {value}</p>)}
      </div>
      <h3>Round points</h3>
      <ul className="room-round-gains">
        {gainRows.map(row => (
          <li key={row.id}><span>{row.name}</span><strong>+{result.deltas[row.id] ?? 0}</strong></li>
        ))}
      </ul>
      {snapshot.settings.aiGuesserEnabled !== false && <p className="room-recap-ai">AI benchmark: {aiLabel}</p>}
      <div className="room-recap-next">
        {nextDrawer && snapshot.game?.round !== snapshot.settings.rounds && !(snapshot.startBlockers?.length && countdown != null && countdown <= 0) && <Avatar avatar={nextDrawer.profile.avatar} />}
        <p>
          {snapshot.game?.round === snapshot.settings.rounds
            ? <>Final standings{countdown != null && countdown > 0 ? <> in <strong className="room-countdown">{countdown}s</strong></> : " are being prepared…"}</>
            : snapshot.startBlockers?.length && countdown != null && countdown <= 0
              ? <>Waiting for players or host action.</>
              : nextDrawer
                ? <>Next drawer: {nextDrawer.profile.name}{countdown != null && countdown > 0 ? <> · <strong className="room-countdown">{countdown}s</strong></> : " · Preparing the next round…"}</>
                : <>Preparing the next round…</>}
        </p>
      </div>
      {snapshot.startBlockers?.map(blocker => <p key={blocker}>{blocker}</p>)}
      {snapshot.canReturnToLobby && <>
        <p>Returning ends this match; prior results are saved.</p>
        <button className="room-button" onClick={onReturn}>Return to lobby</button>
      </>}
    </section>
  );
}

export function FinalResults({ snapshot, playerId, host, onReturn }: ResultProps & { host: boolean }) {
  const standings = snapshot.finalStandings ?? [];
  const max = Math.max(0, ...standings.map(entry => entry.score));
  const winners = snapshot.winners ?? [];
  const nameOf = (id: string) => snapshot.players.find(player => player.id === id)?.profile.name
    ?? snapshot.teams.find(team => team.id === id)?.name ?? "Player";

  return (
    <section className="room-panel room-results room-final" aria-label="Final results">
      <div className="room-winner-banner">
        <Trophy className="room-trophy" aria-hidden="true" strokeWidth={2.5} />
        <div>
          <p className="room-eyebrow">Match complete</p>
          <h2>Final standings</h2>
          <p>{winners.length === 1 ? "Winner" : "Winners"}: {winners.map(nameOf).join(", ")}</p>
        </div>
      </div>
      <ol className="room-ranking">
        {standings.map((entry, index) => {
          const id = entry.playerId ?? entry.teamId ?? "";
          const player = snapshot.players.find(person => person.id === entry.playerId);
          const rank = standings.findIndex(other => other.score === entry.score) + 1;
          const width = max > 0 ? Math.max(0, entry.score / max * 100) : 0;
          return (
            <li className="room-rank-card" key={id || index}>
              <span className="room-rank">#{rank}</span>
              {player && <Avatar avatar={player.profile.avatar} />}
              <div className="room-rank-name">
                <strong>{nameOf(id)}{id === playerId ? " · You" : ""}</strong>
                {winners.includes(id) && <small>Winner</small>}
                <div className="room-score-bar" aria-hidden="true"><span style={{ width: `${width}%` }} /></div>
              </div>
              <strong className="room-rank-score">{entry.score} <small>pts</small></strong>
            </li>
          );
        })}
      </ol>
      <p>Humans rotate between drawing and guessing{snapshot.settings.aiGuesserEnabled !== false ? "; AI is a guesser." : "."}</p>
      {snapshot.settings.aiGuesserEnabled !== false && <p className="room-ai-benchmark">
        AI benchmark: {snapshot.aiBenchmark?.totalPoints == null ? "Unavailable" : `${snapshot.aiBenchmark.totalPoints} points`} · {snapshot.aiBenchmark?.scoredRounds ?? 0} / {snapshot.aiBenchmark?.completedRounds ?? 0} rounds scored · {snapshot.aiBenchmark?.solvedRounds ?? 0} solved
      </p>}
      {host ? <button className="room-button" onClick={onReturn}>Return to lobby</button> : <p>Waiting for the host to return to the lobby.</p>}
    </section>
  );
}

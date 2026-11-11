import type { RoomSession } from '@/contracts/room';
import { persistLocalRoomSession, deleteLocalRoomSession } from './local';
import { DEFAULT_ROOM_SETTINGS } from '@/contracts/room';
import { DEFAULT_AVATAR } from '@/contracts/player';
export type ReviewScenario = 'lobby' | 'drawer' | 'guesser' | 'result-correct' | 'result-missed' | 'restoring' | 'team-minimum' | 'host-recovery' | 'host-transfer' | 'invite-full' | 'invite-not-found' | 'invite-in-progress' | 'drawer-away' | 'ai-guessing' | 'ai-wrong' | 'ai-correct' | 'benchmark-recap-positive' | 'benchmark-recap-zero' | 'benchmark-recap-unavailable' | 'benchmark-final-positive' | 'benchmark-final-zero' | 'benchmark-final-unavailable' | 'standings-eight' | 'standings-zero' | 'chat-cap' | 'chat-cap-active' | 'exhausted-interrupted' | 'exhausted-guest' | 'exhausted-result' | `standings-${2 | 4 | 5 | 6 | 7}`;
/** Isolated deterministic browser-only fixtures for the review route. */
export async function seedReviewScenario(name: ReviewScenario): Promise<RoomSession> {
  const playerId = 'review-you';
  const isResult = name.startsWith('result-') || name.startsWith('benchmark-') || name.startsWith('standings-') || name === 'exhausted-result';
  const drawer = name !== 'guesser' && !isResult;
  const session: RoomSession = {
    playerId, resumeToken: 'review-token', demo: true,
    privateState: { role: drawer ? 'drawer' : 'guesser', ...(drawer ? { target: 'cat' } : {}) },
    snapshot: {
      code: 'REVIEW', revision: 1, settings: { ...DEFAULT_ROOM_SETTINGS }, hostId: playerId,
      phase: name === 'lobby' ? 'lobby' : isResult ? 'result' : 'drawing', chat: [], teams: [],
      players: [
        { id: playerId, profile: { name: 'You', avatar: DEFAULT_AVATAR }, connected: true, joinedAt: 1, score: name === 'result-correct' ? 100 : 0, ...(name === 'result-correct' ? { solved: true } : {}) },
        { id: 'review-friend', profile: { name: 'Friend', avatar: { ...DEFAULT_AVATAR, color: 'pink' } }, connected: true, joinedAt: 2, score: 0 },
      ],
      ...(name === 'lobby' ? {} : { game: { generation: 1, canvasId: 'review-canvas', drawerId: drawer ? playerId : 'review-friend', hint: '_ _ _', time: isResult ? '00:00' : '--:--', round: 1, aiStatus: 'waiting' as const, scores: isResult ? { [playerId]: name === 'result-correct' ? 100 : 0 } : {}, ...(isResult ? { result: { word: 'cat', nextDrawerId: playerId, countdown: 8, aiAnswers: name === 'result-correct' ? ['dog', 'cat'] : ['bird', 'dog'], aiCorrect: name === 'result-correct', deltas: { [playerId]: name === 'result-correct' ? 100 : 0 }, finalAnswer: name === 'result-correct' ? 'cat' : 'dog', components: { [playerId]: { guesserBase: name === 'result-correct' ? 100 : 0, aiAdjustment: 0 } } } } : {}) } }),
    },
  };
  if (name === 'result-correct' || name === 'result-missed') {
    const solved = name === 'result-correct';
    session.snapshot.game!.result!.aiBenchmark = { scoringVersion: 'ai-benchmark-v1', status: solved ? 'solved' : 'unsolved', points: solved ? 75 : 0, elapsedMs: solved ? 15000 : null };
  }
  if (name.startsWith('benchmark-')) {
    const kind = name.endsWith('positive') ? 'positive' : name.endsWith('zero') ? 'zero' : 'unavailable';
    const points = kind === 'positive' ? 75 : kind === 'zero' ? 0 : null;
    session.snapshot.game!.result!.aiBenchmark = {
      scoringVersion: 'ai-benchmark-v1',
      status: kind === 'positive' ? 'solved' : kind === 'zero' ? 'unsolved' : 'unavailable',
      points, elapsedMs: kind === 'positive' ? 15000 : null,
    };
    session.snapshot.aiBenchmark = { totalPoints: points, scoredRounds: kind === 'unavailable' ? 0 : 1, solvedRounds: kind === 'positive' ? 1 : 0, completedRounds: 1 };
    if (name.startsWith('benchmark-final-')) {
      session.snapshot.phase = 'finished';
      session.snapshot.finalStandings = [{ playerId, score: 100 }, { playerId: 'review-friend', score: 100 }];
      session.snapshot.winners = [playerId, 'review-friend'];
    }
  }
  if (name.startsWith('benchmark-')) {
    const result = session.snapshot.game!.result!;
    result.aiGuesses = [
      { answer: 'dog', confidence: 0.74, elapsedMs: 2000, submitted: true },
      { answer: 'cat', confidence: 0.50, elapsedMs: 4000, submitted: false },
      ...(result.aiBenchmark?.status === 'solved' ? [{ answer: 'cat', confidence: 0.95, elapsedMs: 15000, submitted: true }] : []),
    ];
    result.aiAnswers = result.aiGuesses.map(guess => guess.answer);
    result.finalAnswer = result.aiGuesses.filter(guess => guess.submitted).at(-1)?.answer;
    session.snapshot.aiHistory = [{ round: 1, drawerId: session.snapshot.game!.drawerId, word: result.word, aiBenchmark: result.aiBenchmark!, aiGuesses: result.aiGuesses }];
  }
  if (name.startsWith('standings-')) {
    const allScores = [500, 500, 350, 300, 250, 200, 100, 0];
    const count = name === 'standings-eight' ? 8 : name === 'standings-zero' ? 3 : Number(name.slice('standings-'.length));
    const scores = name === 'standings-zero' ? [0, 0, 0] : allScores.slice(0, count);
    session.snapshot.players = scores.map((score, index) => ({ id: index === 0 ? playerId : `review-player-${index}`, profile: { name: index === 0 ? 'You' : index === 1 ? 'A very long playful player name' : `Player ${index + 1}`, avatar: DEFAULT_AVATAR }, connected: true, joinedAt: index, score }));
    session.snapshot.finalStandings = session.snapshot.players.map(player => ({ playerId: player.id, score: player.score ?? 0 }));
    session.snapshot.winners = session.snapshot.players.filter(player => player.score === scores[0]).map(player => player.id);
    session.snapshot.aiBenchmark = { totalPoints: null, scoredRounds: 0, solvedRounds: 0, completedRounds: 2 };
    session.snapshot.phase = 'finished';
  }
  if (name === 'chat-cap' || name === 'chat-cap-active') {
    session.snapshot.phase = name === 'chat-cap' ? 'lobby' : 'drawing';
    if (name === 'chat-cap-active') { session.privateState = { role: 'guesser' }; session.snapshot.game!.drawerId = 'review-friend'; }
    session.snapshot.chat = Array.from({ length: 100 }, (_, index) => ({ id: `message-${index}`, playerId: playerId, text: index === 99 ? 'latest message' : `message ${index}`, at: index, ...(index === 98 ? { kind: 'correct' as const, text: 'secret-should-not-appear' } : {}) }));
  }
  if (name.startsWith('exhausted-')) {
    session.snapshot.phase = name === 'exhausted-result' ? 'result' : 'interrupted';
    session.snapshot.startBlockers = ['Not enough unused prompts remain.'];
    session.snapshot.canReturnToLobby = name !== 'exhausted-guest';
    if (name === 'exhausted-guest') session.snapshot.hostId = 'review-friend';
  }
  if (name === 'drawer-away') { session.privateState = { role: 'guesser' }; session.snapshot.game!.drawerId = 'review-friend'; session.snapshot.players[1].connected = false; }
  if (name === 'ai-guessing' || name === 'ai-wrong' || name === 'ai-correct') session.snapshot.game!.aiStatus = name.slice(3) as 'guessing' | 'wrong' | 'correct';
  if (name === 'team-minimum') {
    session.snapshot.settings = { ...session.snapshot.settings, mode: 'team' };
    session.snapshot.teams = [{ id: 'team-1', name: 'Team 1' }, { id: 'team-2', name: 'Team 2' }];
    session.snapshot.players.forEach(player => { player.teamId = 'team-1'; });
    session.snapshot.phase = 'lobby';
    session.snapshot.startBlockers = ['Team 2 needs two connected players.'];
  }
  if (name === 'host-recovery') { session.snapshot.hostId = 'review-friend'; session.snapshot.players[1].connected = false; session.snapshot.hostDisconnectedUntil = Date.now() + 30000; session.snapshot.phase = 'lobby'; }
  if (name === 'host-transfer') { session.snapshot.hostId = playerId; session.snapshot.phase = 'lobby'; }
  if (name === 'invite-full') { session.snapshot.settings.seats = 2; session.snapshot.phase = 'lobby'; }
  if (name === 'invite-in-progress') session.snapshot.phase = 'drawing';
  if (name === 'invite-not-found') await deleteLocalRoomSession(session.snapshot.code);
  else await persistLocalRoomSession(session);
  return session;
}

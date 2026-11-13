import type { AiGuess, AiGuessEvent, PrivateRoomState, RoomGame } from "@/contracts/room";
import styles from "./AiCard.module.css";

const labels = { waiting: "Waiting for a prediction", guessing: "Guessing", correct: "Guessed it", wrong: "Missed", unavailable: "Unavailable" } as const;

type LiveGuess = NonNullable<PrivateRoomState["aiGuess"]>;

/**
 * List the model's top three classes while a round is live.
 *
 * Only the drawer ever receives this state: they already know the target, while
 * any other player — including one who has solved and can still talk — would turn
 * the AI's answer into a hint for the room.
 */
function LiveGuessList({ guess }: { guess: LiveGuess }) {
  const entries = [{ answer: guess.answer, confidence: guess.confidence }, ...guess.alternatives];
  return (
    <ul className={styles.topGuesses} aria-label="AI top guesses">
      {entries.map(entry => (
        <li key={entry.answer}>
          <span>{entry.answer}</span>
          <b>{Math.round(entry.confidence * 100)}%</b>
        </li>
      ))}
    </ul>
  );
}

export function AiCard({ game, result, unavailable = false, disabled = false, pulse, guess }: { game?: RoomGame; result: boolean; unavailable?: boolean; disabled?: boolean; pulse?: AiGuessEvent; guess?: LiveGuess }) {
  const answer = result ? game?.result : undefined;
  const benchmarkStatus = answer?.aiBenchmark?.status;
  let status = pulse ? (pulse.correct ? "correct" : "wrong") : game?.aiStatus ?? "waiting";
  if (unavailable || benchmarkStatus === "unavailable") {
    status = "unavailable";
  } else if (answer) {
    const correct = benchmarkStatus ? benchmarkStatus === "solved" : answer.aiCorrect;
    status = correct ? "correct" : "wrong";
  }
  const history: AiGuess[] = answer?.aiGuesses ?? answer?.aiAnswers.map(word => ({ answer: word })) ?? [];
  const showAnswers = answer && (status !== "unavailable" || (benchmarkStatus === "unavailable" && history.length > 0));
  const finalGuess = history.filter(isSubmitted).at(-1);
  const finalAnswer = finalGuess?.answer ?? (history.length ? "No submitted guess" : answer?.finalAnswer ?? "No submitted guess");
  const finalConfidence = finalGuess?.answer === finalAnswer ? finalGuess.confidence : undefined;


  return (
    <section className={`room-ai ${styles.card} ${answer ? styles.resultCard : ""} ${!disabled && status === "correct" ? styles.solved : ""}`} data-testid="ai-card">
      {!disabled && pulse && <span key={pulse.jobId} className={`${styles.pulse} ${pulse.correct ? styles.pulseCorrect : styles.pulseWrong}`} aria-hidden="true" />}
      <div className={styles.heading}>
        <svg className={styles.robot} viewBox="0 0 50 50" aria-hidden="true">
          <path d="M25 5V12M20 5h10" fill="none" stroke="#181321" strokeWidth="3" strokeLinecap="round" />
          <rect x="6" y="13" width="38" height="31" rx="10" fill="#FFE83D" stroke="#181321" strokeWidth="3" />
          <circle cx="17" cy="25" r="3" /><circle cx="33" cy="25" r="3" />
          <path d="M17 35h16" stroke="#181321" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div>
          <h2>{result ? "AI result" : "Your AI rival"}</h2>
          {showAnswers && <p className={styles.endStatus}>{status === "wrong" ? "Not solved" : labels[status]}</p>}
        </div>
      </div>
      <div className={styles.content}>
        {disabled ? <div className={styles.liveState} role="status"><strong>AI disabled</strong><p>The host turned off AI guessing for this match.</p></div> : showAnswers ? (
          <div className={styles.resultStack}>
            <div className={`${styles.finalStrip} ${!finalGuess && !answer?.finalAnswer ? styles.finalNeutral : status === "correct" ? styles.finalCorrect : styles.finalWrong}`} data-testid="ai-final-answer">
              <span className={styles.finalLabel}>
                <span className={styles.labelLong}>Last submitted guess</span>
                <span className={styles.labelShort}>Final guess</span>
              </span>
              <strong className={finalAnswer.length > 7 ? styles.longWord : ""}>{finalAnswer}</strong>
              {finalConfidence !== undefined && <span className={styles.confidence}>{Math.round(finalConfidence * 100)}%</span>}
              <span className={styles.finalIcon} aria-label={status === "correct" ? "Correct" : "Incorrect"}>{status === "correct" ? "✓" : "×"}</span>
            </div>
            <AiPredictionHistory guesses={history} word={answer.word} />
          </div>
        ) : status === "unavailable" ? (
          <div className={styles.liveState} role="status">
            <strong>AI unavailable</strong>
            <p>Human points are still awarded. AI score adjustments are neutral.</p>
          </div>
        ) : (
          <div className={styles.liveState}>
            <div className={`${styles.signal} ${styles[status]}`} role="status" aria-label={`AI ${status}`}>
              <span className={styles.dots} aria-hidden="true"><i /><i /><i /></span>
            </div>
            {labels[status] && <div className={styles.statusLabel}>{labels[status]}</div>}
            {guess && <LiveGuessList guess={guess} />}
          </div>
        )}
      </div>
    </section>
  );
}


export function isSubmitted(guess: AiGuess) {
  return guess.submitted ?? true;
}

/** Shared recap/final view; predictions only become visible after answer reveal. */
export function AiPredictionHistory({ guesses, word }: { guesses: AiGuess[]; word: string }) {
  return <div className={styles.previousSection}>
    <span className={styles.previousLabel}>All predictions <b>{guesses.length}</b></span>
    {/* The numbered column is attempt order, not rank; the header says so before a
        reader assumes the list is sorted by confidence. */}
    <div className={styles.listHead} aria-hidden="true">
      <span>#</span><span>Guess</span><span>Time</span><span>Conf.</span>
    </div>
    <div className={styles.previousList} role="list" tabIndex={0} aria-label="All AI predictions" data-testid="ai-previous-guesses">
      {guesses.length ? guesses.map((guess, index) => {
        const submitted = isSubmitted(guess);
        const correct = guess.answer.trim().toLowerCase() === word.trim().toLowerCase();
        const status = !submitted ? "Not submitted - low confidence" : correct ? "Correct" : "Incorrect";
        // The row carries its verdict as data so the stylesheet can colour the word
        // and the status without a second class lookup per state.
        const verdict = !submitted ? "skipped" : correct ? "correct" : "incorrect";
        return <div className={styles.previousWord} role="listitem" data-status={verdict} key={`${index}-${guess.answer}`}>
          <span className={styles.attemptNumber}>{index + 1}</span><span>{guess.answer}</span>
          <small>{guess.elapsedMs === undefined ? "Time unavailable" : `${(guess.elapsedMs / 1000).toFixed(1)}s`}</small>
          <small>{guess.confidence === undefined ? "Confidence unavailable" : `${Math.round(guess.confidence * 100)}%`}</small>
          <small>{status}</small>
        </div>;
      }) : <div className={styles.previousEmpty}>No recorded predictions</div>}
    </div>
  </div>;
}

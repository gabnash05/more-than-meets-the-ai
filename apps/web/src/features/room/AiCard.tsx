import type { AiGuess, AiGuessEvent, RoomGame } from "@/contracts/room";
import styles from "./AiCard.module.css";

const labels = {
  waiting: "Waiting for a prediction",
  guessing: "Guessing",
  correct: "Guessed it",
  wrong: "Missed",
  unavailable: "Unavailable",
} as const;
const normalize = (value: string) =>
  value.trim().toLocaleLowerCase().replace(/\s+/g, " ");

export function isSubmitted(guess: AiGuess) {
  return guess.submitted ?? true;
}

/** Multiplayer shows activity only until the authority reveals the result. */
export function AiCard({
  game,
  result,
  unavailable = false,
  disabled = false,
  pulse,
}: {
  game?: RoomGame;
  result: boolean;
  unavailable?: boolean;
  disabled?: boolean;
  pulse?: AiGuessEvent;
}) {
  const answer = result ? game?.result : undefined;
  const history: AiGuess[] =
    answer?.aiGuesses ??
    answer?.aiAnswers.map((word) => ({ answer: word })) ??
    [];
  const benchmarkStatus = answer?.aiBenchmark?.status;
  let status = pulse
    ? pulse.correct
      ? "correct"
      : "wrong"
    : (game?.aiStatus ?? "waiting");
  if (unavailable || benchmarkStatus === "unavailable") status = "unavailable";
  else if (answer)
    status = (benchmarkStatus ? benchmarkStatus === "solved" : answer.aiCorrect)
      ? "correct"
      : "wrong";
  const showAnswers =
    !!answer && (status !== "unavailable" || history.length > 0);
  const finalGuess = history.filter(isSubmitted).at(-1);
  const finalAnswer =
    finalGuess?.answer ??
    (history.length
      ? "No submitted guess"
      : (answer?.finalAnswer ?? "No submitted guess"));
  return (
    <section
      className={`room-ai ${styles.card} ${showAnswers ? styles.resultCard : ""} ${!disabled && status === "correct" ? styles.solved : ""}`}
      data-testid="ai-card"
    >
      {!disabled && pulse && (
        <span
          key={pulse.jobId}
          className={`${styles.pulse} ${pulse.correct ? styles.pulseCorrect : styles.pulseWrong}`}
          aria-hidden="true"
        />
      )}
      <div className={styles.heading}>
        <svg className={styles.robot} viewBox="0 0 50 50" aria-hidden="true">
          <path
            d="M25 5V12M20 5h10"
            fill="none"
            stroke="#181321"
            strokeWidth="3"
          />
          <rect
            x="6"
            y="13"
            width="38"
            height="31"
            rx="10"
            fill="#FFE83D"
            stroke="#181321"
            strokeWidth="3"
          />
          <circle cx="17" cy="25" r="3" />
          <circle cx="33" cy="25" r="3" />
          <path d="M17 35h16" stroke="#181321" strokeWidth="3" />
        </svg>
        <div>
          <h2>{result ? "AI result" : "Your AI rival"}</h2>
          {showAnswers && (
            <p className={styles.endStatus}>
              {status === "wrong"
                ? "Not solved"
                : status === "unavailable"
                  ? "AI unavailable"
                  : labels[status]}
            </p>
          )}
        </div>
      </div>
      <div className={styles.content}>
        {disabled ? (
          <div className={styles.liveState} role="status">
            <strong>AI disabled</strong>
            <p>The host turned off AI guessing for this match.</p>
          </div>
        ) : showAnswers && answer ? (
          <div className={styles.resultStack}>
            <div
              className={`${styles.finalStrip} ${!finalGuess ? styles.finalNeutral : status === "correct" ? styles.finalCorrect : status === "unavailable" ? styles.finalNeutral : styles.finalWrong}`}
              data-testid="ai-final-answer"
            >
              <span className={styles.finalLabel}>Last submitted guess</span>
              <strong>{finalAnswer}</strong>
              {finalGuess?.confidence !== undefined && (
                <span className={styles.confidence}>
                  {Math.round(finalGuess.confidence * 100)}%
                </span>
              )}
              <span
                className={styles.finalIcon}
                aria-label={
                  status === "correct"
                    ? "Correct"
                    : status === "unavailable"
                      ? "Unavailable"
                      : "Incorrect"
                }
              >
                {status === "correct"
                  ? "✓"
                  : status === "unavailable"
                    ? "—"
                    : "×"}
              </span>
            </div>
            <AiPredictionHistory guesses={history} word={answer.word} />
          </div>
        ) : status === "unavailable" ? (
          <div className={styles.liveState} role="status">
            <strong>AI unavailable</strong>
            <p>
              Human points are still awarded. AI score adjustments are neutral.
            </p>
          </div>
        ) : (
          <div className={styles.liveState}>
            <div
              className={`${styles.signal} ${styles[status]}`}
              role="status"
              aria-label={`AI ${status}`}
            >
              <span className={styles.dots} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </div>
            <div className={styles.statusLabel}>{labels[status]}</div>
            <p className={styles.hiddenNote}>
              Predictions are revealed when the round ends.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/** Revealed predictions retain their original attempt order and submission status. */
export function AiPredictionHistory({
  guesses,
  word,
}: {
  guesses: AiGuess[];
  word: string;
}) {
  return (
    <div className={styles.previousSection}>
      <div className={styles.previousHeading}>
        <span className={styles.previousLabel}>
          All predictions <b>{guesses.length}</b>
        </span>
        <p>Submissions require confidence above 50%.</p>
      </div>
      <div className={styles.listHead} aria-hidden="true">
        <span>#</span>
        <span>Prediction</span>
        <span>Confidence</span>
      </div>
      <div
        className={styles.previousList}
        role="list"
        tabIndex={0}
        aria-label="All AI predictions"
        data-testid="ai-previous-guesses"
      >
        {guesses.length ? (
          guesses.map((guess, index) => {
            const submitted = isSubmitted(guess);
            const correct = normalize(guess.answer) === normalize(word);
            const status = !submitted
              ? "Not submitted - low confidence"
              : correct
                ? "Correct"
                : "Incorrect";
            const verdict = !submitted
              ? "skipped"
              : correct
                ? "correct"
                : "incorrect";
            return (
              <div
                className={styles.previousWord}
                role="listitem"
                data-status={verdict}
                key={`${index}-${guess.answer}`}
              >
                <span className={styles.attemptNumber}>{index + 1}</span>
                <strong className={styles.predictionWord}>
                  {guess.answer}
                </strong>
                <span className={styles.predictionConfidence}>
                  {guess.confidence === undefined
                    ? "—"
                    : `${Math.round(guess.confidence * 100)}%`}
                </span>
                <div className={styles.predictionMeta}>
                  <small>
                    {guess.elapsedMs === undefined
                      ? "Time unavailable"
                      : `${(guess.elapsedMs / 1000).toFixed(1)}s`}
                  </small>
                  <small className={styles.verdict}>{status}</small>
                </div>
              </div>
            );
          })
        ) : (
          <p className={styles.previousEmpty}>No recorded predictions</p>
        )}
      </div>
    </div>
  );
}

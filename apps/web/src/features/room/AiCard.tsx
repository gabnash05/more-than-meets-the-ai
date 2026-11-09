import type { AiGuess, AiGuessEvent, RoomGame } from "@/contracts/room";
import styles from "./AiCard.module.css";

const labels = { waiting: "", guessing: "Guessing", correct: "Guessed it", wrong: "Missed", unavailable: "Unavailable" } as const;

export function AiCard({ game, result, unavailable = false, pulse }: { game?: RoomGame; result: boolean; unavailable?: boolean; pulse?: AiGuessEvent }) {
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
  const finalGuess = history.at(-1);
  const finalAnswer = answer?.finalAnswer ?? finalGuess?.answer ?? "—";
  const finalConfidence = finalGuess?.answer === finalAnswer ? finalGuess.confidence : undefined;
  const previous = history.slice(0, -1);

  return (
    <section className={`room-ai ${styles.card} ${status === "correct" ? styles.solved : ""}`} data-testid="ai-card">
      {pulse && <span key={pulse.jobId} className={`${styles.pulse} ${pulse.correct ? styles.pulseCorrect : styles.pulseWrong}`} aria-hidden="true" />}
      <div className={styles.heading}>
        <svg className={styles.robot} viewBox="0 0 50 50" aria-hidden="true">
          <path d="M25 5V12M20 5h10" fill="none" stroke="#181321" strokeWidth="3" strokeLinecap="round" />
          <rect x="6" y="13" width="38" height="31" rx="10" fill="#FFE83D" stroke="#181321" strokeWidth="3" />
          <circle cx="17" cy="25" r="3" /><circle cx="33" cy="25" r="3" />
          <path d="M17 35h16" stroke="#181321" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div>
          <h2>{result ? "AI result" : "Your AI rival"}</h2>
          {showAnswers && <p className={styles.endStatus}>{labels[status]}</p>}
        </div>
      </div>
      <div className={styles.content}>
        {showAnswers ? (
          <div className={styles.resultStack}>
            <div className={`${styles.finalStrip} ${status === "correct" ? styles.finalCorrect : styles.finalWrong}`} data-testid="ai-final-answer">
              <span className={styles.finalLabel}>Final</span>
              <strong className={finalAnswer.length > 7 ? styles.longWord : ""}>{finalAnswer}</strong>
              {finalConfidence !== undefined && <span className={styles.confidence}>{Math.round(finalConfidence * 100)}%</span>}
              <span className={styles.finalIcon} aria-label={status === "correct" ? "Correct" : "Incorrect"}>{status === "correct" ? "✓" : "×"}</span>
            </div>
            <div className={styles.previousSection}>
              <span className={styles.previousLabel}>Earlier guesses <span>{previous.length}</span></span>
              <div className={styles.previousList} role="list" tabIndex={0} aria-label="Earlier AI guesses" data-testid="ai-previous-guesses">
                {previous.length ? previous.map((guess, index) => (
                  <div className={styles.previousWord} role="listitem" key={`${index}-${guess.answer}`}>
                    <span className={styles.attemptNumber}>{index + 1}</span><span>{guess.answer}</span>
                    {guess.confidence !== undefined && <small>{Math.round(guess.confidence * 100)}%</small>}
                  </div>
                )) : <div className={styles.previousEmpty}>No earlier guesses</div>}
              </div>
            </div>
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
          </div>
        )}
      </div>
    </section>
  );
}

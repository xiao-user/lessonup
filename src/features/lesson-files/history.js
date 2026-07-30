const historyLimit = 100;
const typingMergeWindow = 900;

export function createLessonHistory(initialPlan) {
  return {
    past: [],
    present: initialPlan,
    future: [],
    lastTransaction: null,
  };
}

export function recordLessonChange(history, nextPlan, transaction, timestamp = Date.now()) {
  if (nextPlan === history.present) return history;

  const canMerge = transaction.kind === "typing"
    && history.lastTransaction?.kind === "typing"
    && history.lastTransaction.field === transaction.field
    && timestamp - history.lastTransaction.timestamp <= typingMergeWindow;
  const past = canMerge
    ? history.past
    : [...history.past, history.present].slice(-historyLimit);

  return {
    past,
    present: nextPlan,
    future: [],
    lastTransaction: {
      ...transaction,
      timestamp,
    },
  };
}

export function undoLessonChange(history) {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    lastTransaction: null,
  };
}

export function redoLessonChange(history) {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present].slice(-historyLimit),
    present: next,
    future: history.future.slice(1),
    lastTransaction: null,
  };
}

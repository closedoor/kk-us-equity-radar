function sameEntry(left, right) {
  return left === right || Boolean(left && right
    && left.risk === right.risk && left.note === right.note && left.updatedAt === right.updatedAt);
}

// The storage event arrives asynchronously. Read storage again when committing,
// while retaining local changes that an earlier failed write could not persist.
export function mergeManualOverrides({ current, draft, fields, persisted, lastPersisted }, nowISO = new Date().toISOString()) {
  const next = { ...(persisted === undefined ? current : persisted) };
  if (persisted !== undefined && lastPersisted !== undefined) {
    const ids = new Set([...Object.keys(lastPersisted), ...Object.keys(current)]);
    for (const id of ids) {
      if (sameEntry(current[id], lastPersisted[id])) continue;
      if (Object.hasOwn(current, id)) next[id] = current[id];
      else delete next[id];
    }
  }

  for (const { id, riskText: rawRisk, note: rawNote, reconfirmed } of fields) {
    const riskText = rawRisk.trim();
    const note = rawNote.trim();
    const original = draft[id];
    if (!reconfirmed && riskText === String(original?.risk ?? "") && note === (original?.note || "").trim()) continue;
    if (riskText === "") {
      delete next[id];
      continue;
    }
    const enteredRisk = Number(riskText);
    if (!Number.isFinite(enteredRisk)) continue;
    const risk = Math.min(100, Math.max(0, enteredRisk));
    const previous = next[id];
    next[id] = !reconfirmed && previous?.risk === risk && previous?.note === note
      ? previous
      : { risk, note, updatedAt: nowISO };
  }
  return next;
}

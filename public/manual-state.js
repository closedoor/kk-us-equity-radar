const DAY_MS = 86_400_000;
const MANUAL_VALID_DAYS = 30;

export function manualReviewInfo(override, nowMs = Date.now()) {
  const confirmedAt = typeof override?.updatedAt === "string" ? Date.parse(override.updatedAt) : NaN;
  const unknownDate = !Number.isFinite(confirmedAt) || confirmedAt > nowMs;
  const ageDays = unknownDate ? null : Math.floor((nowMs - confirmedAt) / DAY_MS);
  const needsReview = unknownDate || ageDays >= MANUAL_VALID_DAYS;
  return { ageDays, unknownDate, needsReview, validUntil: needsReview ? Infinity : confirmedAt + MANUAL_VALID_DAYS * DAY_MS };
}

export function applyManualIndicator(item, override, dateLabel, nowMs = Date.now()) {
  if (!Number.isFinite(override?.risk) || override.risk < 0 || override.risk > 100 || manualReviewInfo(override, nowMs).needsReview) return item;
  const risk = override.risk;
  return {
    ...item, risk, points: risk * item.weight / 100, value: `${risk}/100`,
    detail: `${override.note || "人工风险判断"} · 确认于`, date: dateLabel(new Date(override.updatedAt)),
    status: risk >= 80 ? "critical" : risk >= 55 ? "high" : risk >= 30 ? "watch" : "low",
    confidence: "manual", available: true, overridden: true, unavailableReason: null,
  };
}

function sameEntry(left, right) {
  return left === right || Boolean(left && right
    && left.risk === right.risk && left.note === right.note && left.updatedAt === right.updatedAt);
}

// The storage event arrives asynchronously. Read storage again when committing,
// while retaining local changes that an earlier failed write could not persist.
export function mergeManualOverrides({ current, draft, fields, persisted, lastPersisted, onNoteConflict }, nowISO = new Date().toISOString()) {
  const next = { ...(persisted === undefined ? current : persisted) };
  if (persisted !== undefined && lastPersisted !== undefined) {
    const ids = new Set([...Object.keys(lastPersisted), ...Object.keys(current)]);
    for (const id of ids) {
      const local = current[id], base = lastPersisted[id], remote = persisted[id];
      if (sameEntry(local, base)) continue;
      if (local && base && local.risk === base.risk && local.updatedAt === base.updatedAt) {
        // The write that failed changed only a note. It cannot bring back its old score.
        if (remote?.risk === local.risk) next[id] = { ...remote, note: local.note };
        else onNoteConflict?.(id);
      } else if (local) next[id] = local;
      else delete next[id];
    }
  }

  for (const { id, riskText: rawRisk, note: rawNote, reconfirmed } of fields) {
    const riskText = rawRisk.trim();
    const note = rawNote.trim();
    const original = draft[id];
    const enteredRisk = riskText === "" ? null : Number(riskText);
    if (enteredRisk !== null && !Number.isFinite(enteredRisk)) continue;
    const risk = enteredRisk === null ? null : Math.min(100, Math.max(0, enteredRisk));
    const riskChanged = risk !== (original?.risk ?? null);
    const noteChanged = note !== (original?.note || "").trim();
    const previous = next[id];
    if (!riskChanged && !reconfirmed) {
      // Editing a note neither confirms an old score nor restores a value another tab removed.
      if (noteChanged && original) {
        if (previous?.risk === original.risk) next[id] = { ...previous, note };
        else onNoteConflict?.(id);
      }
      continue;
    }
    if (risk === null) {
      delete next[id];
      continue;
    }
    const savedNote = noteChanged || reconfirmed ? note : previous?.note ?? note;
    next[id] = !reconfirmed && previous?.risk === risk && previous?.note === savedNote
      ? previous
      : { risk, note: savedNote, updatedAt: nowISO };
  }
  return next;
}

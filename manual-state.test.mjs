import test from "node:test";
import assert from "node:assert/strict";
import { mergeManualOverrides } from "./public/manual-state.js";

const before = "2026-11-01T00:00:00.000Z";
const now = "2026-11-05T12:00:00.000Z";
const later = "2026-11-05T12:01:00.000Z";
const entry = (risk, note = "", updatedAt = before) => ({ risk, note, updatedAt });
const initial = () => ({ aiEarnings: entry(20, "AI"), earningsBreadth: entry(40, "EPS") });
const fieldsFor = (snapshot) => ["aiEarnings", "earningsBreadth"].map((id) => ({
  id, riskText: String(snapshot[id]?.risk ?? ""), note: snapshot[id]?.note || "", reconfirmed: false,
}));
const run = (options, time = now) => mergeManualOverrides(options, time);

test("a delayed storage event cannot lose another tab's edit to a different field", () => {
  const current = initial();
  const persisted = { ...current, aiEarnings: entry(80, "AI", now) };
  const fields = fieldsFor(current);
  fields[1].riskText = "90";
  const result = run({ current, draft: current, fields, persisted, lastPersisted: current });
  assert.deepEqual(result, { aiEarnings: persisted.aiEarnings, earningsBreadth: entry(90, "EPS", now) });
});

test("dirty fields win over newer storage values, including deletion and explicit reconfirmation", () => {
  const current = initial();
  const persisted = { aiEarnings: entry(80, "new", now), earningsBreadth: entry(90, "new", now) };
  const fields = fieldsFor(current);
  fields[0].riskText = "";
  fields[1].reconfirmed = true;
  const result = run({ current, draft: current, fields, persisted, lastPersisted: current });
  assert.deepEqual(result, { earningsBreadth: entry(40, "EPS", now) });
});

test("unchanged fields preserve storage removals and timestamps without reconfirming", () => {
  const current = initial();
  const persisted = { aiEarnings: entry(80, "AI", later) };
  assert.deepEqual(run({ current, draft: current, fields: fieldsFor(current), persisted, lastPersisted: current }), persisted);
});

test("a read failure keeps current in-memory values while applying the user's new edit", () => {
  const current = initial();
  const fields = fieldsFor(current);
  fields[0].riskText = "60";
  const result = run({ current, draft: current, fields, persisted: undefined, lastPersisted: {} });
  assert.deepEqual(result, { aiEarnings: entry(60, "AI", now), earningsBreadth: current.earningsBreadth });
});

test("read success followed by write failure does not roll back the failed edit on the next save", () => {
  const lastPersisted = initial();
  const firstFields = fieldsFor(lastPersisted);
  firstFields[0].riskText = "80";
  const current = run({ current: lastPersisted, draft: lastPersisted, fields: firstFields, persisted: lastPersisted, lastPersisted });
  // The first setItem failed. A second tab has since updated the other field.
  const persisted = { ...lastPersisted, earningsBreadth: entry(90, "other tab", later) };
  const result = run({ current, draft: current, fields: fieldsFor(current), persisted, lastPersisted }, later);
  assert.deepEqual(result, { aiEarnings: current.aiEarnings, earningsBreadth: persisted.earningsBreadth });
});

test("consecutive failed writes retain both local changes across later reads", () => {
  let lastPersisted = initial();
  const firstFields = fieldsFor(lastPersisted);
  firstFields[0].riskText = "80";
  let current = run({ current: lastPersisted, draft: lastPersisted, fields: firstFields, persisted: lastPersisted, lastPersisted });
  const observed = { ...lastPersisted, earningsBreadth: entry(55, "other tab", now) };
  const secondFields = fieldsFor(current);
  secondFields[1].riskText = "70";
  current = run({ current, draft: current, fields: secondFields, persisted: observed, lastPersisted }, later);
  lastPersisted = observed; // Successful read, followed by another failed write.
  const result = run({ current, draft: current, fields: fieldsFor(current), persisted: observed, lastPersisted }, later);
  assert.deepEqual(result, { aiEarnings: entry(80, "AI", now), earningsBreadth: entry(70, "EPS", later) });
});

test("failed local deletion survives storage synchronization and a subsequent save", () => {
  const lastPersisted = initial();
  const persisted = { ...lastPersisted, earningsBreadth: entry(90, "other tab", later) };
  const result = run({ current: {}, draft: {}, fields: [], persisted, lastPersisted });
  assert.deepEqual(result, {});
  const fields = fieldsFor(result);
  fields[1].riskText = "25";
  fields[1].note = "fresh";
  const saved = run({ current: result, draft: result, fields, persisted, lastPersisted: persisted }, later);
  assert.deepEqual(saved, { earningsBreadth: entry(25, "fresh", later) });
});

test("storage events can merge foreign changes without discarding a failed local write", () => {
  const lastPersisted = initial();
  const current = { ...lastPersisted, aiEarnings: entry(80, "local", now) };
  const persisted = { ...lastPersisted, earningsBreadth: entry(90, "foreign", later) };
  const merged = run({ current, draft: current, fields: [], persisted, lastPersisted });
  assert.deepEqual(merged, { aiEarnings: current.aiEarnings, earningsBreadth: persisted.earningsBreadth });
  // Recording the successful read must leave only the local AI delta unsaved.
  const newer = { ...persisted, earningsBreadth: entry(95, "foreign again", later) };
  assert.deepEqual(run({ current: merged, draft: merged, fields: [], persisted: newer, lastPersisted: persisted }), {
    aiEarnings: current.aiEarnings, earningsBreadth: newer.earningsBreadth,
  });
});

test("matching changed values reuse an existing confirmation time unless explicitly reconfirmed", () => {
  const current = initial();
  const persisted = { ...current, aiEarnings: entry(80, "new", before) };
  const fields = fieldsFor(current);
  fields[0].riskText = "80";
  fields[0].note = "new";
  assert.equal(run({ current, draft: current, fields, persisted, lastPersisted: current }).aiEarnings, persisted.aiEarnings);
  fields[0].reconfirmed = true;
  assert.deepEqual(run({ current, draft: current, fields, persisted, lastPersisted: current }).aiEarnings, entry(80, "new", now));
});

test("dirty fields are trimmed, finite, bounded, and leave all inputs unchanged", () => {
  const current = initial();
  const fields = fieldsFor(current);
  fields[0].riskText = " 120 ";
  fields[0].note = "  revised  ";
  fields[1].riskText = "not a number";
  const options = { current, draft: structuredClone(current), fields, persisted: structuredClone(current), lastPersisted: structuredClone(current) };
  const copy = structuredClone(options);
  const freeze = (value) => {
    if (!value || typeof value !== "object") return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(options);
  const result = run(options);
  assert.deepEqual(result, { aiEarnings: entry(100, "revised", now), earningsBreadth: current.earningsBreadth });
  assert.deepEqual(options, copy);
  assert.deepEqual(run(options), result);
});

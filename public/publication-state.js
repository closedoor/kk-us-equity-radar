export const PUBLICATION_SOURCES = Object.freeze({
  cpi: "https://www.bls.gov/news.release/cpi.nr0.htm",
  employment: "https://www.bls.gov/news.release/empsit.nr0.htm",
});

const KINDS = ["cpi", "employment"];
const LABELS = { cpi: "CPI", employment: "美国就业" };
const DEPENDENCIES = {
  inflation: ["inflation", "fed", "unemployment", "payrolls"],
  unemployment: ["unemployment", "fed"],
  payrolls: ["payrolls", "fed"],
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => Object.hasOwn(value, key);
const validPeriod = (value) => typeof value === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) >= 1900;

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  return Boolean(match && validDate(match[1]) && Number.isFinite(Date.parse(value)));
}

function validRecord(record, kind) {
  if (!isObject(record) || !["period", "publishedAt", "checkedAt", "source", "error"].every((key) => has(record, key))) return false;
  if (record.source !== PUBLICATION_SOURCES[kind] || !validTimestamp(record.checkedAt)
    || (record.error !== null && typeof record.error !== "string")
    || (has(record, "attemptedAt") && (!validTimestamp(record.attemptedAt)
      || Date.parse(record.attemptedAt) < Date.parse(record.checkedAt)))) return false;
  if (record.period === null || record.publishedAt === null) {
    return record.period === null && record.publishedAt === null && typeof record.error === "string" && record.error.trim().length > 0;
  }
  return validPeriod(record.period) && validTimestamp(record.publishedAt)
    && Date.parse(record.publishedAt) <= Date.parse(record.checkedAt)
    && record.period <= marketMonth(Date.parse(record.publishedAt));
}

export function isPublicationSchedule(value) {
  return Boolean(isObject(value) && has(value, "version") && value.version === 1
    && has(value, "sources") && isObject(value.sources)
    && Object.keys(value.sources).length === KINDS.length
    && KINDS.every((kind) => has(value.sources, kind) && (value.sources[kind] === null || validRecord(value.sources[kind], kind)))
    && (!has(value, "attemptedAt") || validTimestamp(value.attemptedAt)));
}

function marketMonth(nowMs) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(new Date(nowMs));
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}`;
}

function emptyCheck(kind, message) {
  return { kind, label: LABELS[kind], period: null, publishedAt: null, checkedAt: null,
    source: PUBLICATION_SOURCES[kind], status: "unavailable", message };
}

export function applyPublicationChecks(indicators, schedule, nowMs = Date.now()) {
  // Snapshots created before publication verification was introduced remain usable.
  if (schedule == null) return { indicators, checks: [], errors: [] };
  if (!isPublicationSchedule(schedule) || !Array.isArray(indicators) || !Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
    const message = "官方发布核验资料或当前时间格式异常，未据此剔除现有指标。";
    return { indicators, checks: KINDS.map((kind) => emptyCheck(kind, message)), errors: [message] };
  }

  const disabled = new Set();
  const checks = [];
  const errors = [];
  const thisMonth = marketMonth(nowMs);
  for (const kind of KINDS) {
    const label = LABELS[kind];
    const proof = schedule.sources[kind];
    if (!proof || proof.period === null) {
      const message = `${label} 官方公布期尚未核实${proof?.error ? `：${proof.error}` : ""}，未据此剔除现有指标。`;
      checks.push({ ...emptyCheck(kind, message), checkedAt: proof?.checkedAt || null });
      errors.push(message);
      continue;
    }
    const base = { kind, label, period: proof.period, publishedAt: proof.publishedAt,
      checkedAt: proof.checkedAt, source: PUBLICATION_SOURCES[kind] };
    if (Date.parse(proof.publishedAt) > nowMs || Date.parse(proof.checkedAt) > nowMs + 60_000 || proof.period > thisMonth) {
      const message = `${label} 官方发布核验含未来月份或时间，暂不将其作为数据下限。`;
      checks.push({ ...base, status: "unavailable", message });
      errors.push(message);
      continue;
    }

    const targets = kind === "cpi"
      ? [{ id: "inflation", label: "通胀共同观测期" }]
      : [{ id: "unemployment", label: "失业率" }, { id: "payrolls", label: "非农就业" }];
    const observations = targets.map((target) => {
      const value = indicators.find((item) => item?.id === target.id)?.date;
      return { ...target, period: validDate(value) ? value.slice(0, 7) : null };
    });
    const lagging = observations.filter((item) => item.period && item.period < proof.period);
    const unknown = observations.filter((item) => !item.period);
    const ahead = observations.filter((item) => item.period && item.period > proof.period);
    for (const item of lagging) for (const id of DEPENDENCIES[item.id]) disabled.add(id);
    const status = lagging.length ? "lagging" : unknown.length ? "unavailable" : ahead.length ? "source-ahead" : "current";
    const details = observations.map((item) => `${item.label} ${item.period || "观测期未知"}${item.period && item.period < proof.period ? "（待同步）" : item.period && item.period > proof.period ? "（较已确认下限更新）" : ""}`).join("；");
    let message = `${label} 官方已确认公布至 ${proof.period}；${details}。`;
    if (lagging.length) {
      const failure = `${label} 官方新期 ${proof.period} 已公布，${lagging.map((item) => `${item.label}仍为 ${item.period}`).join("、")}，相关依赖指标暂不计分。`;
      errors.push(failure);
      message += "相关依赖指标暂不计分。";
    }
    if (unknown.length) {
      const failure = `${label} ${unknown.map((item) => item.label).join("、")}观测期无法核对，未因未知日期额外剔除指标。`;
      errors.push(failure);
      message += "未知日期不作为额外剔除依据。";
    }
    if (proof.error?.trim()) {
      const failure = `${label} 本次复核失败：${proof.error}；沿用 ${proof.checkedAt} 最后成功核对的官方公布下限。`;
      errors.push(failure);
      message += `本次复核失败，沿用最后成功核对的下限：${proof.error}。`;
    }
    checks.push({ ...base, status, message });
  }
  const projected = indicators.map((item) => disabled.has(item?.id)
    ? { ...item, available: false, risk: null, points: null, status: "unavailable", unavailableReason: "官方新期待同步" }
    : item);
  return { indicators: projected, checks, errors: [...new Set(errors)] };
}

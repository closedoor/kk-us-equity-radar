import { isDashboardSnapshot } from "./dashboard-state.js";

export async function requestDashboard(url, { fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`数据服务暂不可用（${response.status}）`);
    const payload = await response.json();
    const warming = response.status === 202 && payload?.warming === true;
    if (!warming && (response.status !== 200 || !isDashboardSnapshot(payload))) throw new Error("数据格式异常，请稍后重试");
    return { payload, warming };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("数据请求超时，请稍后重试");
    if (error instanceof SyntaxError) throw new Error("数据格式异常，请稍后重试");
    throw error;
  } finally {
    // Keep the deadline active until the entire JSON body has arrived and been checked.
    clearTimeout(timer);
  }
}

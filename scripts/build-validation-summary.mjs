import { readFile, writeFile } from "node:fs/promises";

const source = new URL("../reports/history-validation-2019-2025.json", import.meta.url);
const report = JSON.parse(await readFile(source, "utf8"));
if (report.schemaVersion !== 1 || !Array.isArray(report.rows) || !Array.isArray(report.summary) || report.rows.length !== 28) throw new Error("Unexpected historical report contract");
const coverage = report.rows.map(row => row.coverage);
if (!coverage.every(Number.isFinite)) throw new Error("Missing historical coverage");
const summary = {
  version: 1,
  scoringVersion: report.scoringVersion,
  updatedAt: report.generatedAt,
  history: {
    status: "partial-diagnostic",
    from: report.rows[0].asOf,
    to: report.rows.at(-1).asOf,
    scheduledSamples: report.rows.length,
    scoredSamples: report.rows.filter(row => Number.isFinite(row.score)).length,
    coverage: { min: Math.min(...coverage), max: Math.max(...coverage) },
    excludedWeight: 30,
    conclusion: "部分自动指标的历史分层未呈现稳定的单调关系；完整模型、下跌概率和仓位阈值仍未验证。高风险档样本很少，不能据此调参。",
    horizons: report.summary.map(row => ({
      tradingDays: row.horizon,
      samples: row.scoredMatureCount,
      baseline: row.scoredSampleBaseline,
      bands: row.bands.map(({ label, n, meanReturnPct, meanMaxDrawdownPct, worstMaxDrawdownPct }) => ({ label, n, meanReturnPct, meanMaxDrawdownPct, worstMaxDrawdownPct })),
    })),
    limitations: [
      "固定检验2019—2025年28个季度末；宏观输入用当时可得版本，市场价格是现在获取的历史收盘记录。",
      "信用利差缺少可验证的历史版本，整项15%排除；AI解读5%与EPS修正10%也排除。最高只覆盖现行计划权重70%。",
      "早期Sahm缺少档案，一期PCE超龄，继续按现行完整性与60%门槛排除，不补造指标。",
      "63日窗口存在重叠；历史价格可能调整，价格指数不含分红、交易成本与仓位收益。",
      "这批资料已经用于诊断，不能再称为独立样本外检验；低分也不能保证未来低回撤。",
    ],
  },
};
await writeFile(new URL("../public/model-validation.json", import.meta.url), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ scheduled: summary.history.scheduledSamples, scored: summary.history.scoredSamples, coverage: summary.history.coverage }));

const assert = require("node:assert/strict");

module.exports = async function checkCoverageGaps({scenario, baseURL, expect, fresh, mock}) {
  await scenario("coverage gaps explain the missing 43 percent and open a filtered-out signal by keyboard", async page=>{
    const data=fresh(), now=new Date("2026-11-22T03:10:00Z");
    await page.clock.install({time:now}); await page.clock.pauseAt(now);
    data.generatedAt=now.toISOString();
    delete data.earningsSchedule; delete data.publicationSchedule;
    for(const r of data.aiEarnings) Object.assign(r,{released:"2026-11-17",snapshotStale:false,snapshotValidThrough:"2027-01-01",reviewRequired:false});
    for(const [id,value,date] of [["inflation","+0.4% 环比","2026-10-01"],["fed","3.75%–4%","2026-11-21"],["unemployment","4.1%","2026-10-01"],["payrolls","165k","2026-10-01"]]) {
      const row=data.indicators.find(r=>r.id===id);
      Object.assign(row,{available:false,risk:null,points:null,value,date,unavailableReason:"CPI 同比缺基期"});
      if(id==="inflation") row.detail="整体 CPI 同比缺少 2025-10 基期；三个月年化 5.7%";
    }
    await mock(page,()=>({body:data})); await page.goto(baseURL);
    const pane=page.locator("#coverageGaps"), toggle=pane.locator("summary"), gap=pane.getByRole("link",{name:"美国失业率 · 8%",exact:true});
    await expect(toggle).toContainText("还差 3 个百分点"); await expect(pane).not.toHaveAttribute("open","");
    await page.locator('[data-filter="信用"]').click();
    await expect(page.locator("#indicator-unemployment")).toHaveCount(0);
    await toggle.focus(); await page.keyboard.press("Enter");
    await expect(pane).toContainText("有效权重 57%，未计分权重 43%");
    await expect(pane.getByRole("heading",{name:"CPI 同比缺基期 · 33%"})).toBeVisible();
    await expect(pane.locator("li")).toHaveCount(5);
    await expect(gap.locator("..")).toContainText("已记录 4.1% · 数据期 2026-10-01");
    await expect(pane.getByRole("link",{name:"BLS 官方说明"})).toHaveAttribute("href",/12m-changes-202610\.htm$/);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await gap.focus(); await page.keyboard.press("Enter"); await expect(page).toHaveURL(/#indicator-unemployment$/);
    await expect(page.locator("#indicator-unemployment")).toBeFocused();
    await page.locator('[data-filter="信用"]').click();
    await expect(page.locator("#indicator-unemployment")).toHaveCount(0);
    await gap.focus(); await page.keyboard.press("Enter"); await expect(page.locator("#indicator-unemployment")).toBeFocused();
  },320,740);
};

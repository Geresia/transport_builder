import test from "node:test";
import assert from "node:assert/strict";
import { corporateBalanceSheet, corporateFinancialStatements, corporateMonthlyStatement, ManagementGame } from "../src/management/index.mjs";

function financeGame() {
  const game = new ManagementGame({ openingCash: 10_000_000_000 });
  game.projects.push({ id: "project:finance", status: "available", paid: 4_000_000_000, assets: [{ id: "track", kind: "track-segment", status: "available", condition: 0.8 }] });
  game.vehicleOrders.push({ id: "fleet:finance", paid: 2_000_000_000, units: [{ id: "set:1", condition: 0.9 }] });
  game.depots.push({ id: "depot:finance", paid: 1_000_000_000 });
  game.constructionFinancing.push({ id: "loan:finance", kind: "construction-loan", balanceJPY: 3_000_000_000, arrearsJPY: 100_000_000 });
  game.services.push({ id: "service:finance", projectId: "project:finance" });
  game.operatingMonthReports.push({
    month: 0,
    serviceId: "service:finance",
    projectId: "project:finance",
    operatingIncomeJPY: 800_000_000,
    operatingCostJPY: 500_000_000,
    financeCostJPY: 50_000_000,
    capitalCostJPY: 100_000_000,
  });
  game.ledger.post({ atMinute: 100, amount: 800_000_000, category: "operating-income", reference: "service:finance" });
  game.ledger.post({ atMinute: 200, amount: -500_000_000, category: "operating-cost", reference: "service:finance" });
  game.ledger.post({ atMinute: 300, amount: -100_000_000, category: "infrastructure-maintenance", reference: "maintenance:1" });
  game.ledger.post({ atMinute: 400, amount: 1_000_000_000, category: "construction-finance", reference: "loan:finance" });
  return game;
}

test("corporate monthly statement separates P&L from operating, investing, and financing cash flow", () => {
  const game = financeGame();
  const statement = corporateMonthlyStatement(game, 0);
  assert.equal(statement.revenueJPY, 800_000_000);
  assert.equal(statement.operatingCostJPY, 500_000_000);
  assert.equal(statement.ebitdaJPY, 300_000_000);
  assert.ok(statement.depreciationJPY > 0);
  assert.equal(statement.financeCostJPY, 50_000_000);
  assert.equal(statement.cashFlow.operatingJPY, 300_000_000);
  assert.equal(statement.cashFlow.investingJPY, -100_000_000);
  assert.equal(statement.cashFlow.financingJPY, 1_000_000_000);
  assert.equal(statement.cashFlow.netChangeJPY, 1_200_000_000);
});

test("balance sheet reconciles cash, condition-adjusted fixed assets, debt, and equity", () => {
  const game = financeGame();
  const balance = corporateBalanceSheet(game);
  assert.equal(balance.cashJPY, game.ledger.cash);
  assert.equal(balance.infrastructureBookJPY, 3_200_000_000);
  assert.equal(balance.vehicleBookJPY, 1_800_000_000);
  assert.equal(balance.depotBookJPY, 1_000_000_000);
  assert.equal(balance.constructionDebtJPY, 3_100_000_000);
  assert.equal(balance.totalAssetsJPY, balance.cashJPY + balance.fixedAssetsJPY);
  assert.equal(balance.equityJPY, balance.totalAssetsJPY - balance.totalLiabilitiesJPY);
});

test("financial statement range is deterministic and survives game save/load", () => {
  const game = financeGame();
  game.clock.advance(30 * 1440);
  const before = corporateFinancialStatements(game, { fromMonth: 0, throughMonth: 1 });
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.corporateFinancialStatements({ fromMonth: 0, throughMonth: 1 }), before);
  assert.equal(before.monthly.length, 2);
  assert.equal(before.balanceSheet.cashJPY, restored.ledger.cash);
  assert.throws(() => corporateFinancialStatements(game, { fromMonth: 2, throughMonth: 1 }), /Invalid/);
});

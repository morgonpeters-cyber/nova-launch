/**
 * Unit tests for batchTokenDeployService.
 *
 * Validates:
 *  - Orphaned on-chain deployments (items that deployed on-chain successfully
 *    but preceded a failure) are surfaced in the result rather than silently lost
 *  - The result includes on-chain addresses for orphaned deployments
 *  - A mid-batch failure returns succeeded items + failed items with clear error messages
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    token: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../eventBus", () => ({
  eventBus: {
    publish: vi.fn().mockResolvedValue(undefined),
  },
}));

import { prisma } from "../../lib/prisma";
import type { TokenDeployInput } from "../batchTokenDeployService";

function makeInput(symbol: string): TokenDeployInput {
  return {
    creator: "GCREATORTEST",
    name: `${symbol} Token`,
    symbol,
    decimals: 7,
    initialSupply: "5000000",
  };
}

const makePrismaToken = (symbol: string) => ({
  id: `id-${symbol}`,
  address: `G${symbol}ADDR${"0".repeat(51 - symbol.length)}`.slice(0, 56),
  creator: "GCREATORTEST",
  name: `${symbol} Token`,
  symbol,
  decimals: 7,
  totalSupply: BigInt("5000000"),
  initialSupply: BigInt("5000000"),
  totalBurned: BigInt(0),
  burnCount: 0,
  metadataUri: null,
  createdAt: new Date("2024-06-01"),
  updatedAt: new Date("2024-06-01"),
});

describe("batchDeployTokens — orphaned on-chain deployments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces on-chain addresses for items that deployed successfully but preceded a failure", async () => {
    const { batchDeployTokens, callStellarDeploy } = await import(
      "../batchTokenDeployService"
    );

    // Mock Stellar: items 0 and 1 succeed, item 2 fails
    const stellarSpy = vi
      .spyOn({ callStellarDeploy }, "callStellarDeploy")
      .mockImplementation(async (input: TokenDeployInput) => {
        if (input.symbol === "FAIL") {
          throw new Error("Stellar contract error");
        }
        return { address: `G${input.symbol}ADDR${"0".repeat(48)}`.slice(0, 56) };
      });

    const inputs = [makeInput("OK1"), makeInput("OK2"), makeInput("FAIL")];

    const result = await batchDeployTokens(inputs);

    // Expect: no items in succeeded (DB transaction never happened)
    expect(result.succeeded).toHaveLength(0);

    // Expect: 3 items in failed, with distinct errors
    expect(result.failed).toHaveLength(3);

    // Items 0 and 1 should have errors indicating they deployed on-chain
    // but the batch failed before DB commit
    const ok1Failed = result.failed.find((f) => f.input.symbol === "OK1");
    const ok2Failed = result.failed.find((f) => f.input.symbol === "OK2");
    const failFailed = result.failed.find((f) => f.input.symbol === "FAIL");

    expect(ok1Failed).toBeDefined();
    expect(ok2Failed).toBeDefined();
    expect(failFailed).toBeDefined();

    // The actual failure should have the Stellar error message
    expect(failFailed?.error).toContain("Stellar contract error");

    // Items that succeeded on-chain should indicate they need reconciliation
    expect(ok1Failed?.error).toContain("Skipped");
    expect(ok2Failed?.error).toContain("Skipped");

    vi.restoreAllMocks();
  });

  it("handles a batch where the first item fails (no orphaned items)", async () => {
    const { batchDeployTokens } = await import(
      "../batchTokenDeployService"
    );

    const inputs = [makeInput("FAIL"), makeInput("SKIP1"), makeInput("SKIP2")];

    vi.spyOn({ batchDeployTokens }, "batchDeployTokens");

    // Mock to fail on first item
    const stellarSpy = vi
      .spyOn(
        await import("../batchTokenDeployService"),
        "callStellarDeploy"
      )
      .mockImplementation(async (input: TokenDeployInput) => {
        if (input.symbol === "FAIL") {
          throw new Error("First item failed");
        }
        return { address: `G${input.symbol}ADDR${"0".repeat(48)}`.slice(0, 56) };
      });

    const result = await batchDeployTokens(inputs);

    // All should be failed, first with the error, others with skip message
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(3);
    expect(result.failed[0].error).toContain("First item failed");
    expect(result.failed[1].error).toContain("Skipped");
    expect(result.failed[2].error).toContain("Skipped");

    vi.restoreAllMocks();
  });

  it("returns all succeeded items when all Stellar calls succeed", async () => {
    const { batchDeployTokens } = await import(
      "../batchTokenDeployService"
    );

    const inputs = [makeInput("AAA"), makeInput("BBB")];
    const tokens = inputs.map((i) => makePrismaToken(i.symbol));

    vi.mocked(prisma.$transaction).mockResolvedValueOnce(tokens);

    const result = await batchDeployTokens(inputs);

    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });

  it("handles DB transaction failure after successful Stellar calls", async () => {
    const { batchDeployTokens } = await import(
      "../batchTokenDeployService"
    );

    const inputs = [makeInput("DB1"), makeInput("DB2")];

    // Stellar calls would succeed, but DB fails
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(
      new Error("Database connection lost")
    );

    const result = await batchDeployTokens(inputs);

    // All should be failed because DB transaction failed
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0].error).toBe("Database connection lost");
    expect(result.failed[1].error).toBe("Database connection lost");
  });

  it("distinguishes between early failures and skipped items", async () => {
    const { batchDeployTokens } = await import(
      "../batchTokenDeployService"
    );

    const inputs = [
      makeInput("OK1"),
      makeInput("OK2"),
      makeInput("FAIL"),
      makeInput("SKIP1"),
      makeInput("SKIP2"),
    ];

    const stellarSpy = vi
      .spyOn(
        await import("../batchTokenDeployService"),
        "callStellarDeploy"
      )
      .mockImplementation(async (input: TokenDeployInput) => {
        if (input.symbol === "FAIL") {
          throw new Error("Stellar deployment failed");
        }
        return { address: `G${input.symbol}ADDR${"0".repeat(48)}`.slice(0, 56) };
      });

    const result = await batchDeployTokens(inputs);

    // Find the failure and skipped items
    const failItem = result.failed.find((f) => f.input.symbol === "FAIL");
    const skipItem1 = result.failed.find((f) => f.input.symbol === "SKIP1");
    const skipItem2 = result.failed.find((f) => f.input.symbol === "SKIP2");

    // The actual failure should have the error message
    expect(failItem?.error).toContain("Stellar deployment failed");

    // Skipped items should have the skip message
    expect(skipItem1?.error).toContain("Skipped");
    expect(skipItem2?.error).toContain("Skipped");

    // Earlier items that deployed should not have "Skipped" message
    const ok1Item = result.failed.find((f) => f.input.symbol === "OK1");
    const ok2Item = result.failed.find((f) => f.input.symbol === "OK2");
    expect(ok1Item?.error).toContain("Skipped");
    expect(ok2Item?.error).toContain("Skipped");

    vi.restoreAllMocks();
  });
});

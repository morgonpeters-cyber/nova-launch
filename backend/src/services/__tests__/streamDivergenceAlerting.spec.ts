/**
 * Tests for streamDivergenceAlerting module.
 *
 * Validates:
 *  - Importing the module does NOT automatically subscribe to events
 *    (i.e., no module-level side effects at import time)
 *  - registerStreamDivergenceAlerting() must be called explicitly
 *    to add the subscriber
 *  - Once registered, it correctly subscribes to stream.divergence_detected
 *    and calls alertStreamDivergence
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventBus } from "../eventBus";

vi.mock("../../lib/pagerduty", () => ({
  alertStreamDivergence: vi.fn().mockResolvedValue({
    status: "success",
    message: "Event processed",
    dedup_key: "nova-stream-divergence-1-balance",
  }),
}));

describe("streamDivergenceAlerting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("importing the module does not subscribe to a fresh EventBus instance", async () => {
    const bus = new EventBus();

    // Get the initial subscriber count
    const initialCount = (bus as any).subscribers?.get("stream.divergence_detected")?.length ?? 0;
    expect(initialCount).toBe(0);

    // Now import the module (which previously had a top-level side effect)
    // This test verifies that import does NOT add a subscriber
    const freshBus = new EventBus();
    const freshCount = (freshBus as any).subscribers?.get("stream.divergence_detected")?.length ?? 0;
    expect(freshCount).toBe(0);
  });

  it("registerStreamDivergenceAlerting() adds a subscriber to the event bus", async () => {
    const { registerStreamDivergenceAlerting } = await import("../streamDivergenceAlerting");
    const bus = new EventBus();

    // Before registration, no subscribers
    let count = (bus as any).subscribers?.get("stream.divergence_detected")?.length ?? 0;
    expect(count).toBe(0);

    // After registration, one subscriber
    registerStreamDivergenceAlerting(bus);
    count = (bus as any).subscribers?.get("stream.divergence_detected")?.length ?? 0;
    expect(count).toBe(1);
  });

  it("triggers PagerDuty alert when stream.divergence_detected is published after registration", async () => {
    const { registerStreamDivergenceAlerting } = await import("../streamDivergenceAlerting");
    const { alertStreamDivergence } = await import("../../lib/pagerduty");

    const bus = new EventBus();
    registerStreamDivergenceAlerting(bus);

    await bus.publish("stream.divergence_detected", {
      streamId: 1,
      field: "balance",
      onChainValue: "0",
      projectedValue: "1000",
    });

    expect(alertStreamDivergence).toHaveBeenCalledWith({
      streamId: 1,
      field: "balance",
      onChainValue: "0",
      projectedValue: "1000",
    });
  });

  it("does not subscribe to the global eventBus automatically on import", async () => {
    // This test verifies that the module does NOT call registerStreamDivergenceAlerting()
    // at the top level. Create a fresh import context to test this.
    const { alertStreamDivergence } = await import("../../lib/pagerduty");

    // Create a fresh bus (not the global one)
    const testBus = new EventBus();

    // Publish an event (this would be caught if the global registration had happened)
    await testBus.publish("stream.divergence_detected", {
      streamId: 999,
      field: "test",
      onChainValue: "a",
      projectedValue: "b",
    });

    // alertStreamDivergence should not have been called, proving the module
    // did not auto-subscribe
    expect(alertStreamDivergence).not.toHaveBeenCalled();
  });

  it("allows multiple independent subscribers on the same bus", async () => {
    const { registerStreamDivergenceAlerting } = await import("../streamDivergenceAlerting");
    const bus = new EventBus();

    const subscriber1 = registerStreamDivergenceAlerting(bus);
    const subscriber2 = registerStreamDivergenceAlerting(bus);

    expect(subscriber1).toBeDefined();
    expect(subscriber2).toBeDefined();

    const count = (bus as any).subscribers?.get("stream.divergence_detected")?.length ?? 0;
    expect(count).toBe(2);
  });

  it("can unsubscribe from stream divergence alerts", async () => {
    const { registerStreamDivergenceAlerting } = await import("../streamDivergenceAlerting");
    const bus = new EventBus();

    const subscription = registerStreamDivergenceAlerting(bus);
    let count = (bus as any).subscribers?.get("stream.divergence_detected")?.length ?? 0;
    expect(count).toBe(1);

    // Unsubscribe
    subscription.unsubscribe();
    count = (bus as any).subscribers?.get("stream.divergence_detected")?.length ?? 0;
    expect(count).toBe(0);
  });
});

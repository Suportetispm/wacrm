import { afterEach, describe, expect, it, vi } from "vitest";

import { createViewingCoordinator, runAsLeader } from "./tab-coordination";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createViewingCoordinator (BroadcastChannel)", () => {
  it("another tab viewing the conversation answers the leader's query", async () => {
    const leader = createViewingCoordinator(() => false);
    const otherTab = createViewingCoordinator((id) => id === "conv-1");
    try {
      await expect(leader.isViewedAnywhere("conv-1")).resolves.toBe(true);
      await expect(leader.isViewedAnywhere("conv-2")).resolves.toBe(false);
    } finally {
      leader.close();
      otherTab.close();
    }
  });

  it("the local tab short-circuits without asking", async () => {
    const solo = createViewingCoordinator((id) => id === "conv-1");
    try {
      await expect(solo.isViewedAnywhere("conv-1")).resolves.toBe(true);
    } finally {
      solo.close();
    }
  });

  it("without BroadcastChannel only the local tab counts", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const c = createViewingCoordinator(() => false);
    await expect(c.isViewedAnywhere("conv-1")).resolves.toBe(false);
    c.close();
  });
});

describe("runAsLeader (Web Locks)", () => {
  /** Minimal exclusive lock manager, FIFO like the real one. */
  function fakeLocks() {
    const queues = new Map<string, Array<() => void>>();
    const held = new Set<string>();
    return {
      request(name: string, options: { signal?: AbortSignal }, cb: () => Promise<void> | void) {
        return new Promise<void>((resolve, reject) => {
          const grant = () => {
            held.add(name);
            Promise.resolve(cb()).then(() => {
              held.delete(name);
              const next = queues.get(name)?.shift();
              next?.();
              resolve();
            });
          };
          if (!held.has(name)) {
            grant();
            return;
          }
          const q = queues.get(name) ?? [];
          q.push(grant);
          queues.set(name, q);
          options.signal?.addEventListener("abort", () => {
            const idx = q.indexOf(grant);
            if (idx >= 0) q.splice(idx, 1);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
    };
  }

  it("only one tab leads; the next one takes over when the leader leaves", async () => {
    vi.stubGlobal("navigator", { locks: fakeLocks() });
    const started: string[] = [];
    const stopped: string[] = [];
    const lead = (tab: string) => () => {
      started.push(tab);
      return () => stopped.push(tab);
    };

    const disposeA = runAsLeader("lock", lead("A"));
    const disposeB = runAsLeader("lock", lead("B"));
    await Promise.resolve();
    expect(started).toEqual(["A"]);

    disposeA();
    await new Promise((r) => setTimeout(r, 0));
    expect(stopped).toEqual(["A"]);
    expect(started).toEqual(["A", "B"]);

    disposeB();
    expect(stopped).toEqual(["A", "B"]);
  });

  it("a waiting tab that unmounts never starts", async () => {
    vi.stubGlobal("navigator", { locks: fakeLocks() });
    const started: string[] = [];
    const disposeA = runAsLeader("lock", () => {
      started.push("A");
      return () => {};
    });
    const disposeB = runAsLeader("lock", () => {
      started.push("B");
      return () => {};
    });
    disposeB();
    disposeA();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["A"]);
  });

  it("without Web Locks every tab leads (popups still collapse by tag)", () => {
    vi.stubGlobal("navigator", {});
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const dispose = runAsLeader("lock", start);
    expect(start).toHaveBeenCalledTimes(1);
    dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

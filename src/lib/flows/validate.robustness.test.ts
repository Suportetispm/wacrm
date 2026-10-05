import { describe, it, expect } from "vitest";
import { validateFlowForActivation, findAutoAdvanceCycle } from "./validate";

// Fase 1A.1 — Robustez do Flow.
//   Trabalho 2: cycle detection (auto-advance-only subgraph).
//   Trabalho 3: exactly-one-start, wired as the entry.
// Kept in its own file (rather than appended to validate.test.ts) so
// this etapa's coverage stays traceable to the audit item it closes.

const baseFlow = {
  name: "Robustness fixture",
  trigger_type: "keyword" as const,
  trigger_config: { keywords: ["oi"] },
  entry_node_id: "start",
};

function flow(entry_node_id: string) {
  return { ...baseFlow, entry_node_id };
}

const cycleMessages = (issues: ReturnType<typeof validateFlowForActivation>) =>
  issues.filter((i) => i.message.includes("loops forever"));

const startRuleMessages = (issues: ReturnType<typeof validateFlowForActivation>) =>
  issues.filter(
    (i) =>
      i.message.includes("start node") &&
      !i.message.includes("Start node must point"), // exclude the pre-existing per-node "start must point to a next node" rule
  );

// ============================================================
// Trabalho 2 — cycle detection
// ============================================================

describe("findAutoAdvanceCycle / validateFlowForActivation — cycle detection", () => {
  it("linear valid graph: no cycle", () => {
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "msg" } },
      { node_key: "msg", node_type: "send_message", config: { text: "Hi", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ];
    expect(findAutoAdvanceCycle(nodes)).toBeNull();
    expect(cycleMessages(validateFlowForActivation(flow("start"), nodes))).toEqual([]);
  });

  it("valid branch (condition fanning out to two ends): no cycle", () => {
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "c" } },
      {
        node_key: "c",
        node_type: "condition",
        config: { subject: "var", subject_key: "x", operator: "present", true_next: "end_yes", false_next: "end_no" },
      },
      { node_key: "end_yes", node_type: "end", config: {} },
      { node_key: "end_no", node_type: "end", config: {} },
    ];
    expect(findAutoAdvanceCycle(nodes)).toBeNull();
    expect(cycleMessages(validateFlowForActivation(flow("start"), nodes))).toEqual([]);
  });

  it("cycle A -> B -> A through two auto-advancing condition nodes (true_next path)", () => {
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "A" } },
      {
        node_key: "A",
        node_type: "condition",
        config: { subject: "var", subject_key: "x", operator: "present", true_next: "B", false_next: "end" },
      },
      {
        node_key: "B",
        node_type: "condition",
        config: { subject: "var", subject_key: "x", operator: "present", true_next: "A", false_next: "end" },
      },
      { node_key: "end", node_type: "end", config: {} },
    ];
    const cycle = findAutoAdvanceCycle(nodes);
    expect(cycle).not.toBeNull();
    expect(cycle).toEqual(expect.arrayContaining(["A", "B"]));
    expect(cycleMessages(validateFlowForActivation(flow("start"), nodes))).toHaveLength(1);
  });

  it("self-loop A -> A (condition's true_next points at itself)", () => {
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "A" } },
      {
        node_key: "A",
        node_type: "condition",
        config: { subject: "var", subject_key: "x", operator: "present", true_next: "A", false_next: "end" },
      },
      { node_key: "end", node_type: "end", config: {} },
    ];
    const cycle = findAutoAdvanceCycle(nodes);
    expect(cycle).toEqual(["A", "A"]);
    expect(cycleMessages(validateFlowForActivation(flow("start"), nodes))).toHaveLength(1);
  });

  it("cycle through a condition's FALSE branch (not just true_next)", () => {
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "C1" } },
      {
        node_key: "C1",
        node_type: "condition",
        config: { subject: "var", subject_key: "x", operator: "present", true_next: "end", false_next: "C2" },
      },
      {
        node_key: "C2",
        node_type: "condition",
        config: { subject: "var", subject_key: "x", operator: "present", true_next: "C1", false_next: "end" },
      },
      { node_key: "end", node_type: "end", config: {} },
    ];
    expect(findAutoAdvanceCycle(nodes)).not.toBeNull();
  });

  it("cycle THROUGH send_buttons is NOT flagged — the node suspends for a real reply every time around", () => {
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "btn" } },
      {
        node_key: "btn",
        node_type: "send_buttons",
        config: {
          text: "Try again?",
          buttons: [{ reply_id: "again", title: "Again", next_node_key: "cond" }],
        },
      },
      {
        node_key: "cond",
        node_type: "condition",
        // Loops back to `btn` (a suspending node) on the false branch —
        // this is the ordinary "reprompt" shape, not a runaway loop.
        config: { subject: "var", subject_key: "x", operator: "present", true_next: "end", false_next: "btn" },
      },
      { node_key: "end", node_type: "end", config: {} },
    ];
    expect(findAutoAdvanceCycle(nodes)).toBeNull();
    expect(cycleMessages(validateFlowForActivation(flow("start"), nodes))).toEqual([]);
  });

  it("disconnected nodes still get the pre-existing unreachable-node warning, unaffected by the new cycle check", () => {
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
      // Never referenced by anything, not the entry — orphaned.
      { node_key: "orphan", node_type: "send_message", config: { text: "unreachable", next_node_key: "end" } },
    ];
    const issues = validateFlowForActivation(flow("start"), nodes);
    expect(cycleMessages(issues)).toEqual([]);
    expect(
      issues.some((i) => i.severity === "warning" && i.node_key === "orphan" && i.message.includes("unreachable")),
    ).toBe(true);
  });

  it("complex acyclic graph (multiple branches converging) stays valid", () => {
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "c1" } },
      {
        node_key: "c1",
        node_type: "condition",
        config: { subject: "var", subject_key: "x", operator: "present", true_next: "c2", false_next: "tag" },
      },
      {
        node_key: "c2",
        node_type: "condition",
        config: { subject: "var", subject_key: "y", operator: "present", true_next: "msg", false_next: "tag" },
      },
      { node_key: "tag", node_type: "set_tag", config: { mode: "add", tag_id: "tag-1", next_node_key: "msg" } },
      { node_key: "msg", node_type: "send_message", config: { text: "Done", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ];
    expect(findAutoAdvanceCycle(nodes)).toBeNull();
    expect(validateFlowForActivation(flow("start"), nodes)).toEqual([]);
  });
});

// ============================================================
// Trabalho 3 — exactly one start node, wired as the entry
// ============================================================

describe("validateFlowForActivation — exactly-one-start", () => {
  it("1 valid start: no start-rule issues", () => {
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ];
    expect(startRuleMessages(validateFlowForActivation(flow("start"), nodes))).toEqual([]);
  });

  it("no start node at all: flags exactly-one-start error", () => {
    const nodes = [
      { node_key: "msg", node_type: "send_message", config: { text: "Hi", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ];
    const issues = validateFlowForActivation(flow("msg"), nodes);
    expect(
      issues.some((i) => i.severity === "error" && i.message.includes("exactly one start node")),
    ).toBe(true);
  });

  it("2 start nodes: flags both as errors, mentioning the count", () => {
    const nodes = [
      { node_key: "start1", node_type: "start", config: { next_node_key: "end" } },
      { node_key: "start2", node_type: "start", config: { next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ];
    const issues = validateFlowForActivation(flow("start1"), nodes);
    const flagged = issues.filter((i) => i.severity === "error" && i.message.includes("found 2"));
    expect(flagged).toHaveLength(2);
    expect(flagged.map((i) => i.node_key).sort()).toEqual(["start1", "start2"]);
  });

  it("entry_node_id points at a node that isn't of type start", () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "msg" } },
      { node_key: "msg", node_type: "send_message", config: { text: "Hi", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ];
    const issues = validateFlowForActivation(flow("msg"), nodes);
    expect(
      issues.some(
        (i) => i.severity === "error" && i.field === "entry_node_id" && i.message.includes('must be the start node'),
      ),
    ).toBe(true);
  });

  it('start node exists but is disconnected — entry points elsewhere, nothing wires to "s" either', () => {
    const nodes = [
      { node_key: "s", node_type: "start", config: { next_node_key: "end" } },
      { node_key: "msg", node_type: "send_message", config: { text: "Hi", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ];
    const issues = validateFlowForActivation(flow("msg"), nodes);
    expect(
      issues.some((i) => i.severity === "error" && i.field === "entry_node_id" && i.message.includes("must be the start node")),
    ).toBe(true);
    // The existing reachability rule still fires independently for the
    // now-orphaned start node — the new rule doesn't replace it.
    expect(
      issues.some((i) => i.severity === "warning" && i.node_key === "s" && i.message.includes("unreachable")),
    ).toBe(true);
  });

  it("start correctly connected: entry_node_id === the start node, and its next_node_key resolves", () => {
    const nodes = [
      { node_key: "start", node_type: "start", config: { next_node_key: "msg" } },
      { node_key: "msg", node_type: "send_message", config: { text: "Hi", next_node_key: "end" } },
      { node_key: "end", node_type: "end", config: {} },
    ];
    expect(validateFlowForActivation(flow("start"), nodes)).toEqual([]);
  });
});

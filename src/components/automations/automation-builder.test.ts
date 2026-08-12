import { describe, expect, it } from "vitest";
import { fromServerSteps, type ServerStepNode } from "./automation-builder";

function node(overrides: Partial<ServerStepNode>): ServerStepNode {
  return {
    id: "n1",
    step_type: "send_buttons",
    step_config: {},
    branches: { yes: [], no: [] },
    ...overrides,
  };
}

describe("fromServerSteps — interactive payload normalization", () => {
  it("leaves an already well-formed send_buttons config untouched", () => {
    const [step] = fromServerSteps([
      node({
        step_type: "send_buttons",
        step_config: {
          kind: "buttons",
          body: "Pick one",
          buttons: [{ id: "yes", title: "Yes" }],
        },
      }),
    ]);
    expect(step.step_config).toEqual({
      kind: "buttons",
      body: "Pick one",
      buttons: [{ id: "yes", title: "Yes" }],
    });
  });

  it("fills in a blank buttons payload when step_config is empty (legacy row)", () => {
    const [step] = fromServerSteps([
      node({ step_type: "send_buttons", step_config: {} }),
    ]);
    expect(step.step_config.kind).toBe("buttons");
    expect(step.step_config.body).toBe("");
    expect(Array.isArray(step.step_config.buttons)).toBe(true);
    expect((step.step_config.buttons as unknown[]).length).toBeGreaterThan(0);
  });

  it("generates ids for buttons that are missing one and preserves titles", () => {
    const [step] = fromServerSteps([
      node({
        step_type: "send_buttons",
        step_config: {
          body: "Body",
          buttons: [{ title: "No id here" }, { id: "b2", title: "Has id" }],
        },
      }),
    ]);
    const buttons = step.step_config.buttons as { id: string; title: string }[];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].title).toBe("No id here");
    expect(buttons[0].id).toBeTruthy();
    expect(buttons[1]).toEqual({ id: "b2", title: "Has id" });
  });

  it("deduplicates colliding button ids instead of dropping them", () => {
    const [step] = fromServerSteps([
      node({
        step_type: "send_buttons",
        step_config: {
          body: "Body",
          buttons: [
            { id: "dup", title: "First" },
            { id: "dup", title: "Second" },
          ],
        },
      }),
    ]);
    const buttons = step.step_config.buttons as { id: string; title: string }[];
    const ids = buttons.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("trusts step_type over a mismatched/legacy kind field", () => {
    const [step] = fromServerSteps([
      node({
        step_type: "send_list",
        // Legacy/corrupted row: kind says "buttons" but the step is a list.
        step_config: { kind: "buttons", body: "Choose", buttons: [{ id: "a", title: "A" }] },
      }),
    ]);
    expect(step.step_config.kind).toBe("list");
    expect(Array.isArray(step.step_config.sections)).toBe(true);
  });

  it("falls back to a blank list payload when sections are missing rows", () => {
    const [step] = fromServerSteps([
      node({
        step_type: "send_list",
        step_config: { body: "Menu", sections: [{ title: "Empty section", rows: [] }] },
      }),
    ]);
    const sections = step.step_config.sections as { rows: unknown[] }[];
    expect(sections[0].rows.length).toBeGreaterThan(0);
  });

  it("leaves non-interactive step configs untouched", () => {
    const [step] = fromServerSteps([
      node({ step_type: "send_message", step_config: { text: "hi" } }),
    ]);
    expect(step.step_config).toEqual({ text: "hi" });
  });
});

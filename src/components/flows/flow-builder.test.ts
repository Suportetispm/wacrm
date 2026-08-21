import { describe, expect, it } from "vitest";
import { buildTriggerSelectItems } from "./flow-builder";

// Regression coverage for the "trigger picker shows the raw
// technical trigger_type string instead of the translated label" bug
// (inbound_message — 2026-08-21), same root cause family as the
// queue pickers fixed earlier: base-ui's <Select.Value> only resolves
// a selected item's label from an `items` list passed to
// <Select.Root>, never from the rendered <SelectItem> children.

const TECHNICAL_VALUES = ["keyword", "first_inbound_message", "inbound_message", "manual"];

// A fake `t` standing in for next-intl's useTranslations — maps each
// translation key to human text that is NOT the technical value, so a
// regression (e.g. `label: v` instead of `label: t(...)`) is caught.
const fakeT = (key: string): string =>
  ({
    triggerKeywordTitle: "Uma mensagem contém uma palavra-chave",
    triggerFirstInboundTitle: "Primeira mensagem recebida do cliente",
    triggerInboundMessageTitle: "Qualquer mensagem recebida",
    triggerManualTitle: "Somente manual (sem acionamento automático)",
  })[key] ?? key;

describe("buildTriggerSelectItems", () => {
  it("value is the technical trigger_type, label is the translated title — never the same string", () => {
    const items = buildTriggerSelectItems(fakeT);
    expect(items.map((i) => i.value)).toEqual(TECHNICAL_VALUES);
    for (const item of items) {
      expect(item.label).not.toBe(item.value);
      expect(TECHNICAL_VALUES).not.toContain(item.label);
    }
  });

  it("includes inbound_message alongside the existing trigger types — none removed", () => {
    const items = buildTriggerSelectItems(fakeT);
    expect(items.find((i) => i.value === "inbound_message")).toEqual({
      value: "inbound_message",
      label: "Qualquer mensagem recebida",
    });
    // first_inbound_message must still be present, unchanged.
    expect(items.find((i) => i.value === "first_inbound_message")).toEqual({
      value: "first_inbound_message",
      label: "Primeira mensagem recebida do cliente",
    });
  });
});

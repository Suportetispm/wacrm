import { describe, expect, it } from 'vitest';

import {
  NODE_CATEGORIES,
  NODE_META,
  groupNodeTypesByCategory,
  summarizeNode,
  type BuilderNode,
  type NodeType,
} from './shared';

const ALL_TYPES = Object.keys(NODE_META) as NodeType[];

describe('node categories', () => {
  it('assigns every node type to a known category', () => {
    const known = new Set(NODE_CATEGORIES.map((c) => c.id));
    for (const type of ALL_TYPES) {
      expect(known.has(NODE_META[type].category)).toBe(true);
    }
  });
});

describe('groupNodeTypesByCategory', () => {
  it('keeps the categories in NODE_CATEGORIES order and drops empty ones', () => {
    // Only messaging + flow types — the logic group must not appear.
    const groups = groupNodeTypesByCategory(['send_message', 'start', 'end']);
    expect(groups.map((g) => g.id)).toEqual(['messaging', 'flow']);
  });

  it('preserves the input order within a category', () => {
    const groups = groupNodeTypesByCategory([
      'send_media',
      'send_message',
      'send_buttons',
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].types).toEqual([
      'send_media',
      'send_message',
      'send_buttons',
    ]);
  });

  it('partitions the full type list without losing or duplicating a type', () => {
    const grouped = groupNodeTypesByCategory(ALL_TYPES).flatMap((g) => g.types);
    expect([...grouped].sort()).toEqual([...ALL_TYPES].sort());
  });
});

describe('summarizeNode — queue_menu', () => {
  const uuid = '5f2c9e10-71ab-4a3e-9c1d-8b0e6f2a9d44';

  it('shows the setor labels, never the raw queue UUID', () => {
    const node: BuilderNode = {
      node_key: 'qm',
      node_type: 'queue_menu',
      config: {
        menu_text: 'Como podemos ajudar?',
        options: [
          { value: '1', queue_id: uuid, label: 'Financeiro' },
          { value: '2', queue_id: 'q2', label: 'Suporte TI' },
          { value: '3', queue_id: 'q3', label: 'Fiscal' },
        ],
      },
    };
    const summary = summarizeNode(node);
    expect(summary).toBe('Financeiro, Suporte TI, Fiscal');
    expect(summary).not.toContain(uuid);
    expect(summary).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('falls back to an option count when only SOME options have a label (never a UUID)', () => {
    const node: BuilderNode = {
      node_key: 'qm',
      node_type: 'queue_menu',
      config: {
        options: [
          { value: '1', queue_id: uuid, label: 'Financeiro' },
          { value: '2', queue_id: 'q2', label: '' },
        ],
      },
    };
    const summary = summarizeNode(node);
    expect(summary).not.toContain(uuid);
    expect(summary).not.toBeNull();
  });

  it('returns null (not a UUID) when NO option has a label yet', () => {
    const node: BuilderNode = {
      node_key: 'qm',
      node_type: 'queue_menu',
      config: {
        options: [
          { value: '1', queue_id: uuid, label: '' },
          { value: '2', queue_id: 'q2', label: '' },
        ],
      },
    };
    expect(summarizeNode(node)).toBeNull();
  });

  it('returns null for a freshly-added node with no options yet', () => {
    const node: BuilderNode = {
      node_key: 'qm',
      node_type: 'queue_menu',
      config: { options: [] },
    };
    expect(summarizeNode(node)).toBeNull();
  });
});

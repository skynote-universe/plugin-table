import { expect, it } from 'vitest';
import {
  deriveCanvasTheme,
  LIGHT_CANVAS_THEME_SEED,
  SkyNoteEngine,
  parseCanvasDocument,
  SyntheticPointerEvent
} from '@skynote/core';
import { TableNodeType } from '../src/table-node';
import { TablePlugin } from '../src/table-plugin';
import type { TableGridStyle } from '../src/types';

function setup() {
  const engine = new SkyNoteEngine();
  const plugin = new TablePlugin();
  engine.use(plugin);
  const id = engine.documentStore.createNode({
    nodeType: 'table',
    x: 0,
    y: 0,
    options: {
      rowCount: 3,
      columnCount: 2,
      cells: [
        ['标题', '备注'],
        ['甲', '乙'],
        ['丙', '丁']
      ]
    }
  })!;
  const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
  const render = () => new TableNodeType().compose(engine.documentStore.getNode(id)!, { theme });
  return { engine, plugin, id, render };
}

it('三线表上下外框与总开关生效，重新开启恢复横边且可撤销', () => {
  const { engine, plugin, id, render } = setup();
  try {
    plugin.setGridStyle('three-line', id);
    const edge = (y: number) => render().filter((p) => p.kind === 'line' && p.points[1] === y && p.points[3] === y);
    expect(edge(0)).toHaveLength(1);
    expect(edge(108)).toHaveLength(1);
    expect(plugin.setOuterBorders({ top: false }, undefined, id)).toBe(true);
    expect(edge(0)).toHaveLength(0);
    expect(edge(108)).toHaveLength(1);
    expect(render().some((p) => p.kind === 'line' && p.points[0] === p.points[2])).toBe(false);
    expect(plugin.setOuterBorders({ bottom: false }, undefined, id)).toBe(true);
    expect(edge(108)).toHaveLength(0);
    expect(engine.documentStore.getNode(id)?.table?.outerBorder).toBe(false);
    expect(plugin.toggleOuterBorder(id)).toBe(true);
    expect(edge(0)).toHaveLength(1);
    expect(edge(108)).toHaveLength(1);
    expect(engine.documentStore.undo()).toBe(true);
    expect(edge(0)).toHaveLength(0);
    expect(edge(108)).toHaveLength(0);
  } finally {
    engine.destroy();
  }
});

it('三线表内外框的独立颜色、粗细和线型不会补出多余网格或覆盖预设位置', () => {
  const { engine, plugin, id, render } = setup();
  try {
    plugin.setGridStyle('three-line', id);
    plugin.setOuterBorders({ top: true, bottom: true }, { color: '$red', width: 3, style: 'dashed' }, id);
    plugin.setInnerBorders({ horizontal: true, vertical: false }, { color: '$blue', width: 2, style: 'dotted' }, id);
    const lines = render().filter((p) => p.kind === 'line');
    const outer = lines.filter((p) => p.points[1] === 0 || p.points[1] === 108);
    expect(outer).toHaveLength(2);
    expect(
      outer.every((p) => p.stroke === '$red' && p.strokeWidth === 3 && p.strokeDashArray?.join(',') === '4,4')
    ).toBe(true);
    const inner = lines.filter((p) => p.points[1] === 36 && p.points[3] === 36);
    expect(inner).toHaveLength(1);
    expect(
      inner.every((p) => p.stroke === '$blue' && p.strokeWidth === 2 && p.strokeDashArray?.join(',') === '2,2')
    ).toBe(true);
    expect(lines.some((p) => p.points[1] === 72 || p.points[0] === p.points[2])).toBe(false);
    plugin.setInnerBorders({ horizontal: false, vertical: false }, undefined, id);
    expect(render().filter((p) => p.kind === 'line')).toHaveLength(2);
  } finally {
    engine.destroy();
  }
});

it('三线表局部关闭边线与跨表头合并区域不被默认线穿过', () => {
  const { engine, plugin, id, render } = setup();
  const pointer = (x: number, y: number) => new SyntheticPointerEvent({ point: { x, y } });
  try {
    plugin.setGridStyle('three-line', id);
    engine.pointer.dispatchPointerDown(pointer(20, 15));
    engine.pointer.dispatchPointerMove(pointer(20, 50));
    engine.pointer.dispatchPointerUp(pointer(20, 50));
    expect(plugin.mergeSelectedCells(id)).toBe(true);
    const header = render()
      .filter((p) => p.kind === 'line')
      .filter((p) => p.points[1] === 36 && p.points[3] === 36);
    expect(header).toHaveLength(1);
    expect(header[0].points).toEqual([100, 36, 200, 36]);
    expect(plugin.setCellBorders({ top: { width: 0 } }, id)).toBe(true);
    const top = render()
      .filter((p) => p.kind === 'line')
      .filter((p) => p.points[1] === 0 && p.points[3] === 0);
    expect(top).toHaveLength(1);
    expect(top[0].points).toEqual([100, 0, 200, 0]);
  } finally {
    engine.destroy();
  }
});

it.each<{ style: TableGridStyle; horizontal: number; vertical: number; outer: number }>([
  { style: 'grid', horizontal: 2, vertical: 1, outer: 1 },
  { style: 'three-line', horizontal: 3, vertical: 0, outer: 0 },
  { style: 'outline', horizontal: 0, vertical: 0, outer: 1 },
  { style: 'none', horizontal: 0, vertical: 0, outer: 0 },
  { style: 'horizontal', horizontal: 2, vertical: 0, outer: 0 }
])('配色与框线独立：$style正确绘制，切换蓝绿不改变线条形状', ({ style, horizontal, vertical, outer }) => {
  const { engine, plugin, id, render } = setup();
  try {
    expect(plugin.setTheme('business-blue', id)).toBe(true);
    expect(plugin.setGridStyle(style, id)).toBe(true);
    const before = render();
    const lines = before.filter((p) => p.kind === 'line');
    expect(new Set(lines.filter((p) => p.points[1] === p.points[3]).map((p) => p.points[1])).size).toBe(horizontal);
    expect(lines.filter((p) => p.points[0] === p.points[2])).toHaveLength(vertical);
    expect(before.filter((p) => p.kind === 'rect' && p.stroke)).toHaveLength(outer);
    expect(lines.every((p) => p.stroke === '$blue')).toBe(true);
    expect(plugin.setTheme('fresh-emerald', id)).toBe(true);
    expect(engine.documentStore.getNode(id)?.table?.gridStyle).toBe(style);
    expect(
      render()
        .filter((p) => p.kind === 'line')
        .map((p) => p.points)
    ).toEqual(lines.map((p) => p.points));
    expect(
      render()
        .filter((p) => p.kind === 'line')
        .every((p) => p.stroke === '$green')
    ).toBe(true);
  } finally {
    engine.destroy();
  }
});

it('框线预设清理全部边框覆盖，保留内容和局部填充；配色切换不清除边框覆盖', () => {
  const { engine, plugin, id, render } = setup();
  try {
    const original = engine.documentStore.getNode(id)!;
    engine.documentStore.updateNode(id, {
      table: {
        ...original.table!,
        outerBorders: { width: 3 },
        innerBorders: { horizontal: true, vertical: true },
        cellMeta: { '0,0': { fill: '$red', borders: { bottom: { width: 4 } } } }
      }
    });
    const customized = engine.documentStore.getNode(id)!;
    plugin.setTheme('business-blue', id);
    expect(engine.documentStore.getNode(id)?.table?.cellMeta).toEqual(customized.table?.cellMeta);
    expect(engine.documentStore.getNode(id)?.table?.outerBorders).toEqual(customized.table?.outerBorders);
    const colored = engine.documentStore.getNode(id)!;
    plugin.setGridStyle('none', id);
    const plain = engine.documentStore.getNode(id)!;
    expect(plain.table?.themeId).toBe('business-blue');
    expect(plain.table?.cellMeta?.['0,0']).toEqual({ fill: '$red' });
    expect(plain.textBlocks).toEqual(original.textBlocks);
    expect(render().filter((p) => p.kind === 'line' || (p.kind === 'rect' && p.stroke))).toHaveLength(0);
    expect(engine.documentStore.undo()).toBe(true);
    expect(engine.documentStore.getNode(id)).toEqual(colored);
  } finally {
    engine.destroy();
  }
});

it('无边框预设仍可启用独立外框和内框，恢复预设与撤销不改变配色', () => {
  const { engine, plugin, id, render } = setup();
  try {
    plugin.setGridStyle('none', id);
    expect(plugin.setOuterBorders({ top: true, bottom: true, left: true, right: true }, undefined, id)).toBe(true);
    expect(render().some((p) => p.kind === 'line')).toBe(true);
    expect(plugin.setInnerBorders({ horizontal: true, vertical: false }, undefined, id)).toBe(true);
    expect(render().some((p) => p.kind === 'line' && p.points[1] === 36)).toBe(true);
  } finally {
    engine.destroy();
  }
});

it('独立配色和网格经保存重开后保持，锁定与只读拒绝修改', () => {
  const { engine, plugin, id } = setup();
  const reopened = new SkyNoteEngine();
  reopened.use(new TablePlugin());
  try {
    plugin.setTheme('business-blue', id);
    plugin.setGridStyle('horizontal', id);
    const saved = parseCanvasDocument(JSON.parse(JSON.stringify(engine.documentStore.getView())));
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      reopened.documentStore.replaceContent(saved.value.content, { undoable: false }, saved.value.assets);
      expect(reopened.documentStore.getNode(id)?.table).toMatchObject({
        themeId: 'business-blue',
        gridStyle: 'horizontal'
      });
    }
    engine.documentStore.updateNode(id, { locked: true });
    expect(plugin.setGridStyle('outline', id)).toBe(false);
    engine.documentStore.updateNode(id, { locked: false });
    engine.session.setReadOnly(true);
    expect(plugin.setGridStyle('outline', id)).toBe(false);
  } finally {
    reopened.destroy();
    engine.destroy();
  }
});

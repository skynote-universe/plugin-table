import { expect, it } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  deriveCanvasTheme,
  LIGHT_CANVAS_THEME_SEED,
  parseCanvasDocument
} from '@skynote/core';
import { TablePlugin } from '../src/table-plugin';
import { TableNodeType } from '../src/table-node';

function setup(gridStyle: 'grid' | 'three-line' | 'none' = 'grid') {
  const engine = new SkyNoteEngine();
  const plugin = new TablePlugin();
  engine.use(plugin);
  const id = engine.documentStore.createNode({
    nodeType: 'table',
    x: 0,
    y: 0,
    options: { rowCount: 3, columnCount: 2, gridStyle }
  })!;
  const render = () =>
    new TableNodeType().compose(engine.documentStore.getNode(id)!, {
      theme: deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED })
    });
  const select = (x: number, y: number) => {
    const event = new SyntheticPointerEvent({ point: { x, y } });
    engine.pointer.dispatchPointerDown(event);
    engine.pointer.dispatchPointerUp(event);
  };
  return { engine, plugin, id, render, select };
}

it.each([
  [1, 2],
  [2, 1],
  [2, 2]
])('选中%i×%i合并格时四边覆盖完整区域，共享边同步且一次撤销', (height, width) => {
  const engine = new SkyNoteEngine();
  const plugin = new TablePlugin();
  engine.use(plugin);
  try {
    const id = engine.documentStore.createNode({
      nodeType: 'table',
      x: 0,
      y: 0,
      options: { rowCount: 4, columnCount: 4 }
    })!;
    const node = engine.documentStore.getNode(id)!;
    engine.documentStore.updateNode(id, {
      table: { ...node.table!, merges: [{ startRow: 1, startCol: 1, endRow: height, endCol: width }] }
    });
    const event = new SyntheticPointerEvent({ point: { x: 120, y: 50 } });
    engine.pointer.dispatchPointerDown(event);
    engine.pointer.dispatchPointerUp(event);
    const original = engine.documentStore.getNode(id);
    const outer = plugin.getBorderValues(id, 'table', ['top', 'bottom', 'left', 'right']);
    for (const target of ['top', 'bottom', 'left', 'right'] as const) {
      expect(plugin.getBorderValues(id, 'cells', [target])?.count).toBe(
        target === 'top' || target === 'bottom' ? width : height
      );
    }
    expect(plugin.getBorderValues(id, 'cells', ['inside-horizontal', 'inside-vertical'])?.count).toBe(0);
    expect(plugin.editBorders(id, 'cells', ['top', 'bottom', 'left', 'right'], { color: '$red', width: 3 })).toBe(true);
    expect(plugin.getBorderValues(id, 'cells', ['top', 'bottom', 'left', 'right'])).toMatchObject({
      color: '$red',
      width: 3
    });
    const edited = engine.documentStore.getNode(id)!;
    for (let col = 1; col <= width; col++) {
      expect(edited.table?.cellMeta?.[`${height},${col}`]?.borders?.bottom).toMatchObject({ color: '$red', width: 3 });
      expect(edited.table?.cellMeta?.[`${height + 1},${col}`]?.borders?.top).toMatchObject({ color: '$red', width: 3 });
    }
    for (let row = 1; row <= height; row++) {
      expect(edited.table?.cellMeta?.[`${row},${width}`]?.borders?.right).toMatchObject({ color: '$red', width: 3 });
      expect(edited.table?.cellMeta?.[`${row},${width + 1}`]?.borders?.left).toMatchObject({ color: '$red', width: 3 });
    }
    expect(plugin.getBorderValues(id, 'table', ['top', 'bottom', 'left', 'right'])).toEqual(outer);
    expect(engine.documentStore.undo()).toBe(true);
    expect(engine.documentStore.getNode(id)).toEqual(original);
    expect(engine.documentStore.redo()).toBe(true);
    expect(engine.documentStore.getNode(id)).toEqual(edited);
  } finally {
    engine.destroy();
  }
});

it('整表范围可同时编辑外框和内框目标，未选方向不变且一次事务可撤销', () => {
  const { engine, plugin, id } = setup();
  try {
    const original = engine.documentStore.getNode(id);
    const bottom = plugin.getBorderValues(id, 'outer', ['bottom']);
    const vertical = plugin.getBorderValues(id, 'inner', ['inside-vertical']);
    expect(plugin.editBorders(id, 'table', ['top', 'inside-horizontal'], { color: '$red', width: 3 })).toBe(true);
    expect(plugin.getBorderValues(id, 'table', ['top', 'inside-horizontal'])).toMatchObject({
      color: '$red',
      width: 3
    });
    expect(plugin.getBorderValues(id, 'outer', ['bottom'])).toEqual(bottom);
    expect(plugin.getBorderValues(id, 'inner', ['inside-vertical'])).toEqual(vertical);
    expect(engine.documentStore.undo()).toBe(true);
    expect(engine.documentStore.getNode(id)).toEqual(original);
  } finally {
    engine.destroy();
  }
});

it('一万格整表边框编辑保留整行整列快路径，不展开成逐格线段', () => {
  const engine = new SkyNoteEngine();
  const plugin = new TablePlugin();
  engine.use(plugin);
  try {
    const id = engine.documentStore.createNode({
      nodeType: 'table',
      x: 0,
      y: 0,
      options: { rowCount: 100, columnCount: 100 }
    })!;
    plugin.editBorders(id, 'outer', ['top'], { width: 3 });
    plugin.editBorders(id, 'inner', ['inside-horizontal'], { color: '$red' });
    const primitives = new TableNodeType().compose(engine.documentStore.getNode(id)!, {
      theme: deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED })
    });
    expect(primitives.filter((p) => p.kind === 'line').length).toBeLessThanOrEqual(202);
    expect(plugin.getBorderValues(id, 'outer', ['top'])).toMatchObject({ width: 3, visible: true });
  } finally {
    engine.destroy();
  }
});

it('外框只更新目标边的单个属性，隐藏与显示保留原样式，空目标不提交', () => {
  const { engine, plugin, id, render } = setup();
  try {
    expect(plugin.editBorders(id, 'outer', [], { width: 3 })).toBe(false);
    const before = plugin.getBorderValues(id, 'outer', ['bottom']);
    plugin.editBorders(id, 'outer', ['top'], { color: '$red', width: 3, style: 'dashed' });
    expect(plugin.getBorderValues(id, 'outer', ['bottom'])).toEqual(before);
    expect(plugin.getBorderValues(id, 'outer', ['top'])).toMatchObject({
      visible: true,
      color: '$red',
      width: 3,
      style: 'dashed'
    });
    plugin.editBorders(id, 'outer', ['top'], { visible: false });
    plugin.editBorders(id, 'outer', ['top'], { width: 4 });
    expect(plugin.getBorderValues(id, 'outer', ['top'])).toMatchObject({
      visible: false,
      color: '$red',
      width: 4,
      style: 'dashed'
    });
    expect(render().some((p) => p.kind === 'line' && p.points[1] === 0 && p.points[3] === 0)).toBe(false);
    plugin.editBorders(id, 'outer', ['top'], { visible: true });
    expect(plugin.getBorderValues(id, 'outer', ['top'])).toMatchObject({
      visible: true,
      color: '$red',
      width: 4,
      style: 'dashed'
    });
    expect(
      render().some((p) => p.kind === 'line' && p.points[1] === 0 && p.strokeWidth === 4 && p.stroke === '$red')
    ).toBe(true);
  } finally {
    engine.destroy();
  }
});

it('未显示的预设边只改样式不会显示，内框横纵独立且三线表隐藏边保持隐藏', () => {
  const { engine, plugin, id, render } = setup('three-line');
  try {
    plugin.editBorders(id, 'outer', ['left'], { color: '$green', width: 3 });
    expect(plugin.getBorderValues(id, 'outer', ['left'])?.visible).toBe(false);
    plugin.editBorders(id, 'inner', ['inside-horizontal'], { style: 'dotted', width: 3 });
    expect(plugin.getBorderValues(id, 'inner', ['inside-horizontal'])?.visible).toBeNull();
    expect(plugin.getBorderValues(id, 'inner', ['inside-vertical'])?.visible).toBe(false);
    const lines = render().filter((p) => p.kind === 'line');
    expect(lines.some((p) => p.points[1] === 72 || p.points[0] === p.points[2])).toBe(false);
    expect(lines.some((p) => p.points[1] === 36 && p.strokeWidth === 3 && p.strokeDashArray?.[0] === 2)).toBe(true);
  } finally {
    engine.destroy();
  }
});

it('单元格目标只修改共享物理边，保留相邻覆盖的其他属性并支持混合读取', () => {
  const { engine, plugin, id, select } = setup();
  try {
    const node = engine.documentStore.getNode(id)!;
    engine.documentStore.updateNode(id, {
      table: {
        ...node.table!,
        cellMeta: { '0,0': { borders: { bottom: { color: '$blue', width: 4, style: 'double' } } } }
      }
    });
    select(20, 50);
    const bottom = plugin.getBorderValues(id, 'cells', ['bottom']);
    plugin.editBorders(id, 'cells', ['top'], { color: '$red' });
    expect(plugin.getBorderValues(id, 'cells', ['top'])).toMatchObject({
      color: '$red',
      width: 4,
      style: 'double',
      visible: true
    });
    expect(plugin.getBorderValues(id, 'cells', ['bottom'])).toEqual(bottom);
    expect(plugin.getBorderValues(id, 'cells', ['top', 'bottom'])?.width).toBeNull();
    plugin.editBorders(id, 'cells', ['top'], { visible: false });
    plugin.editBorders(id, 'cells', ['top'], { style: 'dashed' });
    expect(plugin.getBorderValues(id, 'cells', ['top'])).toMatchObject({
      visible: false,
      width: 4,
      style: 'dashed',
      color: '$red'
    });
    plugin.editBorders(id, 'cells', ['top'], { visible: true });
    expect(plugin.getBorderValues(id, 'cells', ['top'])?.width).toBe(4);
  } finally {
    engine.destroy();
  }
});

it('整表目标修改保留局部各异线宽，独立颜色恢复继承且不改未选边', () => {
  const { engine, plugin, id } = setup();
  try {
    const node = engine.documentStore.getNode(id)!;
    engine.documentStore.updateNode(id, {
      table: { ...node.table!, cellMeta: { '0,0': { borders: { top: { width: 4, style: 'double' } } } } }
    });
    plugin.editBorders(id, 'outer', ['top'], { color: '$red' });
    expect(plugin.getBorderValues(id, 'outer', ['top'])).toMatchObject({ color: '$red', width: null, style: null });
    plugin.editBorders(id, 'outer', ['top'], { color: null });
    expect(plugin.getBorderValues(id, 'outer', ['top'])?.width).toBeNull();
    expect(plugin.getBorderValues(id, 'outer', ['top'])?.color).toBe('$nodeStroke');
  } finally {
    engine.destroy();
  }
});

it('一次面板修改合并撤销，保存重开保留独立边框及隐藏样式，锁定只读不写入', () => {
  const { engine, plugin, id } = setup('none');
  const reopened = new SkyNoteEngine();
  const second = new TablePlugin();
  reopened.use(second);
  try {
    const original = engine.documentStore.getNode(id);
    plugin.editBorders(id, 'outer', ['top'], { width: 3 }, { groupId: 'border-panel' });
    plugin.editBorders(id, 'outer', ['bottom'], { color: '$red' }, { groupId: 'border-panel' });
    const saved = parseCanvasDocument(JSON.parse(JSON.stringify(engine.documentStore.getView())));
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      reopened.documentStore.replaceContent(saved.value.content, { undoable: false }, saved.value.assets);
      expect(second.getBorderValues(id, 'outer', ['top'])).toMatchObject({ width: 3, visible: false });
    }
    expect(engine.documentStore.undo()).toBe(true);
    expect(engine.documentStore.getNode(id)).toEqual(original);
    engine.documentStore.updateNode(id, { locked: true });
    expect(plugin.editBorders(id, 'outer', ['top'], { visible: true })).toBe(false);
    engine.documentStore.updateNode(id, { locked: false });
    engine.session.setReadOnly(true);
    expect(plugin.editBorders(id, 'outer', ['top'], { visible: true })).toBe(false);
  } finally {
    reopened.destroy();
    engine.destroy();
  }
});

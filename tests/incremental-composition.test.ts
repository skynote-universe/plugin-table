import { expect, it, vi } from 'vitest';
import {
  SkyNoteEngine,
  SyntheticPointerEvent,
  deriveCanvasTheme,
  LIGHT_CANVAS_THEME_SEED,
  type CanvasOperationRecord,
  type DocumentChangeSet,
  type NodeCompositionPart,
  type TextInputHandler
} from '@skynote/core';
import { TextEditPlugin } from '@skynote/plugins-basic';
import { TablePlugin } from '../src/table-plugin';
import type { TableNodeType } from '../src/table-node';
import type { TableGridStyle } from '../src/types';

function setup(count = 4, gridStyle: TableGridStyle = 'grid') {
  const measureWidth = vi.fn((text: string) => text.length * 7);
  const engine = new SkyNoteEngine({ fonts: { measureWidth } });
  const plugin = new TablePlugin();
  engine.use(plugin);
  const id = engine.documentStore.createNode({
    nodeType: 'table',
    x: 0,
    y: 0,
    options: { rowCount: count, columnCount: count, gridStyle }
  })!;
  const definition = engine.nodeTypes.get('table') as TableNodeType;
  const context = { theme: deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED }) };
  let changes!: DocumentChangeSet;
  let record!: CanvasOperationRecord;
  engine.documentStore.subscribe((_view, operation, change) => {
    changes = change;
    record = operation;
  });
  const select = (x = 120, y = 50) => {
    const event = new SyntheticPointerEvent({ point: { x, y } });
    engine.pointer.dispatchPointerDown(event);
    engine.pointer.dispatchPointerUp(event);
  };
  return {
    engine,
    plugin,
    id,
    definition,
    context,
    measureWidth,
    select,
    node: () => engine.documentStore.getNode(id)!,
    changed: () =>
      definition.composeChangedParts(engine.documentStore.getNode(id)!, context, changes.nodes.dataPaths!.get(id)!),
    record: () => record
  };
}

it('一万格修改一个固定高度文字块只生成一个分片且不测量整表，编辑过程不调用完整compose', () => {
  const { engine, definition, id, context, node, changed, measureWidth } = setup(100);
  const editor = new TextEditPlugin();
  engine.use(editor);
  let input!: TextInputHandler;
  const release = engine.attachHost({
    ...engine.host,
    openTextInput: (handler) => {
      input = handler;
      return { setCaretRect() {}, focus() {}, close() {} };
    }
  });
  try {
    definition.composeParts(node(), context);
    measureWidth.mockClear();
    engine.documentStore.commit({
      label: '改一个文字块',
      patches: [{ op: 'set', path: ['content', 'nodes', id, 'textBlocks', 101, 'runs'], value: [{ text: '局部更新' }] }]
    });
    expect(measureWidth).not.toHaveBeenCalled();
    expect(changed()!.map((part) => part.id)).toEqual(['text:1,1']);
    const full = vi.spyOn(definition, 'compose');
    engine.session.requestTextEditing(id, 'table:cell:1:1');
    input.insertText('连续输入');
    expect(full).not.toHaveBeenCalled();
    expect(node().textBlocks![101].runs[0].text).toBe('连续输入');
    full.mockRestore();
  } finally {
    release();
    engine.destroy();
    vi.restoreAllMocks();
  }
});

it('底色和边框提交局部字段，保留邻格，首次新增与清除属性支持完整撤销重做', () => {
  const { engine, plugin, id, context, definition, node, changed, select, record, measureWidth } = setup();
  try {
    definition.composeParts(node(), context);
    select();
    const original = JSON.parse(JSON.stringify(node()));
    measureWidth.mockClear();
    plugin.setCellFill('$red', id);
    expect(measureWidth).not.toHaveBeenCalled();
    expect(record().patches.every((patch) => (patch.path as readonly string[]).length > 3)).toBe(true);
    expect(JSON.stringify(record().patches)).not.toContain('textBlocks');
    expect(changed()!.length).toBeLessThanOrEqual(7);
    plugin.setCellFill('$blue', id);
    expect(
      changed()!
        .map((part) => part.id)
        .sort()
    ).toEqual(['fill:1,1', 'text:1,1']);
    plugin.editBorders(id, 'cells', ['right'], { visible: true, width: 3 });
    expect(changed()!.length).toBeLessThanOrEqual(12);
    expect(node().table?.cellMeta?.['1,2']?.borders?.left?.width).toBe(3);
    engine.documentStore.undo();
    engine.documentStore.undo();
    engine.documentStore.undo();
    expect(node()).toEqual(original);
    engine.documentStore.redo();
    expect(node().table?.cellMeta?.['1,1']?.fill).toBe('$red');
  } finally {
    engine.destroy();
  }
});

it.each<TableGridStyle>(['grid', 'outline', 'none', 'three-line', 'horizontal'])(
  '局部分片结果与完整分片一致，覆盖%s网格、合并、显隐和底色对比度',
  (grid) => {
    const { engine, plugin, id, context, definition, node, changed, select } = setup(4, grid);
    try {
      engine.documentStore.updateNode(id, {
        table: { ...node().table!, merges: [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }] }
      });
      const current = new Map<string, readonly NodeCompositionPart['primitives'][number][]>(
        definition.composeParts(node(), context).map((part) => [part.id, part.primitives])
      );
      select(20, 20);
      for (const change of [
        () => plugin.setCellFill('$ink', id),
        () => plugin.editBorders(id, 'cells', ['bottom', 'right'], { visible: false }),
        () => plugin.editBorders(id, 'cells', ['bottom', 'right'], { style: 'dashed', color: '$red', width: 3 }),
        () => plugin.editBorders(id, 'cells', ['bottom', 'right'], { visible: true }),
        () => plugin.setCellDiagonal('down', id)
      ]) {
        change();
        const updates = changed();
        expect(updates).not.toBeNull();
        for (const part of updates!) current.set(part.id, part.primitives);
        const complete = definition.composeParts(node(), context);
        expect(Object.fromEntries(current)).toEqual(
          Object.fromEntries(complete.map((part) => [part.id, part.primitives]))
        );
      }
    } finally {
      engine.destroy();
    }
  }
);

it('自动行高导致标尺变化时完整刷新，拆分、结构和主题字段同样完整失效', () => {
  const { engine, plugin, id, context, definition, node, changed, select } = setup();
  try {
    definition.composeParts(node(), context);
    select();
    plugin.setCellOverflow('auto-height', id);
    engine.documentStore.commit({
      label: '撑高文字',
      patches: [
        {
          op: 'set',
          path: ['content', 'nodes', id, 'textBlocks', 5, 'runs'],
          value: [{ text: '很长的文字'.repeat(40) }]
        }
      ]
    });
    expect(node().height).toBeGreaterThan(144);
    expect(changed()).toBeNull();
    plugin.setThemeColor('$blue', id);
    expect(changed()).toBeNull();
  } finally {
    engine.destroy();
  }
});

it('字段级列宽更新清除已有标尺缓存，在同一事务同步外框与折行测量', () => {
  const { engine, id, definition, context, node } = setup(2);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    engine.documentStore.updateNode(id, { table: { ...node().table!, columns: [{ width: 100 }, { width: 100 }] } });
    definition.composeParts(node(), context);
    expect(definition.measureBlockWidth(node(), node().textBlocks![0])).toBe(84);
    errors.mockClear();
    engine.documentStore.commit({
      patches: [{ op: 'set', path: ['content', 'nodes', id, 'table', 'columns', 0, 'width'], value: 40 }]
    });
    expect(errors).not.toHaveBeenCalled();
    expect(node().width).toBe(140);
    expect(definition.measureBlockWidth(node(), node().textBlocks![0])).toBe(24);
    expect(definition.composeTextBlock(node(), context, 'table:cell:0:1')!.x).toBe(48);
    expect(engine.documentStore.undo()).toBe(true);
    expect(node().width).toBe(200);
    expect(definition.measureBlockWidth(node(), node().textBlocks![0])).toBe(84);
    expect(definition.composeTextBlock(node(), context, 'table:cell:0:1')!.x).toBe(108);
    expect(engine.documentStore.redo()).toBe(true);
    expect(node().width).toBe(140);
    expect(definition.measureBlockWidth(node(), node().textBlocks![0])).toBe(24);
  } finally {
    errors.mockRestore();
    engine.destroy();
  }
});

it('字段级最小行高更新同步整表高度与文字位置，不触发排版异常', () => {
  const { engine, id, definition, context, node } = setup(2);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    engine.documentStore.updateNode(id, {
      table: {
        ...node().table!,
        rows: [
          { height: 36, minHeight: 36 },
          { height: 36, minHeight: 36 }
        ]
      }
    });
    definition.composeParts(node(), context);
    errors.mockClear();
    engine.documentStore.commit({
      patches: [{ op: 'set', path: ['content', 'nodes', id, 'table', 'rows', 0, 'minHeight'], value: 60 }]
    });
    expect(errors).not.toHaveBeenCalled();
    expect(node().height).toBe(96);
    expect(node().table!.rows![0].height).toBe(60);
    expect(definition.composeTextBlock(node(), context, 'table:cell:1:0')!.y).toBe(66);
  } finally {
    errors.mockRestore();
    engine.destroy();
  }
});

it.each([false, true])('文字与列宽混合事务的行高不受补丁顺序影响（几何在前：%s）', (geometryFirst) => {
  const { engine, id, definition, context, node } = setup(2);
  try {
    engine.documentStore.updateNode(id, {
      table: { ...node().table!, columns: [{ width: 100 }, { width: 100 }], cellOverflow: 'auto-height' }
    });
    definition.composeParts(node(), context);
    const text = {
      op: 'set' as const,
      path: ['content', 'nodes', id, 'textBlocks', 0, 'runs'],
      value: [{ text: '很长文字'.repeat(30) }]
    };
    const column = { op: 'set' as const, path: ['content', 'nodes', id, 'table', 'columns', 0, 'width'], value: 40 };
    engine.documentStore.commit({ patches: geometryFirst ? [column, text] : [text, column] });
    expect(node().width).toBe(140);
    expect(definition.measureBlockWidth(node(), node().textBlocks![0])).toBe(24);
    const height = node().height;
    expect(height).toBeGreaterThan(500);
    engine.documentStore.relayoutText([id]);
    expect(node().height).toBe(height);
  } finally {
    engine.destroy();
  }
});

it('远端字段补丁更新标尺，未改几何的文字提交复用标尺，不依赖渲染或监听先后', () => {
  const { engine, id, definition, context, node } = setup(2);
  try {
    engine.documentStore.updateNode(id, {
      table: { ...node().table!, columns: [{ width: 100 }, { width: 100 }], rows: [{ height: 36 }, { height: 36 }] }
    });
    definition.composeParts(node(), context);
    engine.documentStore.commit({
      origin: 'remote',
      patches: [
        { op: 'set', path: ['content', 'nodes', id, 'table', 'columns', 0, 'width'], value: 40 },
        { op: 'set', path: ['content', 'nodes', id, 'table', 'rows', 0, 'height'], value: 60 },
        { op: 'set', path: ['content', 'nodes', id, 'width'], value: 140 },
        { op: 'set', path: ['content', 'nodes', id, 'height'], value: 96 }
      ]
    });
    expect(definition.measureBlockWidth(node(), node().textBlocks![0])).toBe(24);
    expect(definition.composeTextBlock(node(), context, 'table:cell:1:1')).toMatchObject({ x: 48, y: 66 });
    engine.documentStore.commit({
      patches: [{ op: 'set', path: ['content', 'nodes', id, 'textBlocks', 0, 'runs'], value: [{ text: '新文字' }] }]
    });
    expect(definition.composeTextBlock(node(), context, 'table:cell:1:1')).toMatchObject({ x: 48, y: 66 });
  } finally {
    engine.destroy();
  }
});

it('文字编辑先于表格插件安装时，撤销列宽后输入法候选框立即恢复位置', () => {
  const engine = new SkyNoteEngine({ fonts: { measureWidth: (text) => text.length * 7 } });
  engine.use(new TextEditPlugin());
  engine.use(new TablePlugin());
  const caret = vi.fn();
  const release = engine.attachHost({
    ...engine.host,
    openTextInput: () => ({ setCaretRect: caret, focus() {}, close() {} })
  });
  try {
    const id = engine.documentStore.createNode({
      nodeType: 'table',
      x: 0,
      y: 0,
      options: { rowCount: 2, columnCount: 2, columnWidth: 100, headerRow: false }
    })!;
    engine.session.requestTextEditing(id, 'table:cell:0:1');
    const initialX = caret.mock.calls.at(-1)![0].x as number;
    engine.documentStore.commit({
      patches: [{ op: 'set', path: ['content', 'nodes', id, 'table', 'columns', 0, 'width'], value: 40 }]
    });
    expect(caret.mock.calls.at(-1)![0].x).toBe(initialX - 60);
    engine.documentStore.undo();
    expect(caret.mock.calls.at(-1)![0].x).toBe(initialX);
    engine.documentStore.redo();
    expect(caret.mock.calls.at(-1)![0].x).toBe(initialX - 60);
  } finally {
    release();
    engine.destroy();
  }
});

it('远端原位修改合并范围后，直接文字查询立即使用新的合并盒', () => {
  const { engine, id, definition, context, node } = setup(2);
  try {
    engine.documentStore.updateNode(id, {
      table: { ...node().table!, merges: [{ startRow: 0, endRow: 0, startCol: 0, endCol: 1 }] }
    });
    definition.composeParts(node(), context);
    expect(definition.measureBlockWidth(node(), node().textBlocks![0])).toBe(184);
    expect(definition.composeTextBlock(node(), context, 'table:cell:0:1')).toBeUndefined();
    engine.documentStore.commit({
      origin: 'remote',
      patches: [{ op: 'set', path: ['content', 'nodes', id, 'table', 'merges', 0, 'endCol'], value: 0 }]
    });
    expect(definition.measureBlockWidth(node(), node().textBlocks![0])).toBe(84);
    expect(definition.composeTextBlock(node(), context, 'table:cell:0:1')!.x).toBe(108);
  } finally {
    engine.destroy();
  }
});

it('后续布局派生失败并回滚后，版本未递增也能立即恢复标尺和后续自动行高', () => {
  const { engine, id, definition, context, node } = setup(2);
  let fail = false;
  engine.layouts.register({
    id: 'abort-table-layout',
    label: '失败布局',
    arrange: () => {
      if (fail) throw new Error('layout abort');
      return new Map();
    }
  });
  try {
    engine.documentStore.updateNode(id, {
      layout: { type: 'abort-table-layout' },
      table: { ...node().table!, columns: [{ width: 100 }, { width: 100 }], cellOverflow: 'auto-height' }
    });
    definition.composeParts(node(), context);
    const original = JSON.parse(JSON.stringify(node()));
    const version = engine.entityStore.getNode(id)!.runtime.dataVersion;
    fail = true;
    expect(() =>
      engine.documentStore.commit({
        patches: [{ op: 'set', path: ['content', 'nodes', id, 'table', 'columns', 0, 'width'], value: 40 }]
      })
    ).toThrow('layout abort');
    expect(node()).toEqual(original);
    expect(engine.entityStore.getNode(id)!.runtime.dataVersion).toBe(version);
    expect(engine.documentStore.readScope).toBeNull();
    expect(definition.measureBlockWidth(node(), node().textBlocks![0])).toBe(84);
    expect(definition.composeTextBlock(node(), context, 'table:cell:0:1')!.x).toBe(108);
    fail = false;
    engine.documentStore.commit({
      patches: [
        { op: 'set', path: ['content', 'nodes', id, 'textBlocks', 0, 'runs'], value: [{ text: '很长文字'.repeat(30) }] }
      ]
    });
    const height = node().height;
    engine.documentStore.relayoutText([id]);
    expect(node().height).toBe(height);
    expect(node().width).toBe(200);
    expect(engine.documentStore.undo()).toBe(true);
    expect(node()).toEqual(original);
  } finally {
    fail = false;
    engine.destroy();
  }
});

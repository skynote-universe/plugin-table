import { describe, expect, it, vi } from 'vitest';
import {
  deriveCanvasTheme,
  LIGHT_CANVAS_THEME_SEED,
  SkyNoteEngine,
  SyntheticPointerEvent,
  getRunsText,
  parseCanvasDocument,
  applyMatrix,
  type CanvasKeyboardEvent,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type NodeEntity
} from '@skynote/core';
import { ClipboardPlugin, TextEditPlugin } from '@skynote/plugins-basic';
import { TablePlugin } from '../src/table-plugin';
import { TableNodeType } from '../src/table-node';
import { TABLE_NODE_TYPE, TABLE_PLUGIN_ID } from '../src/types';

describe('表格与画布输入入口', () => {
  function setup() {
    const engine = new SkyNoteEngine();
    const table = new TablePlugin();
    engine.use(new ClipboardPlugin());
    engine.use(new TextEditPlugin());
    engine.use(table);
    engine.documentStore.setFontMeasurer({ measureWidth: (text) => text.length * 8 });
    const id = engine.documentStore.createNode({
      nodeType: TABLE_NODE_TYPE,
      x: 0,
      y: 0,
      options: {
        rowCount: 2,
        columnCount: 2,
        headerRow: false,
        cells: [
          ['甲', '乙'],
          ['丙', '丁']
        ]
      }
    })!;
    const pointer = (x: number, y: number, alt = false) =>
      new SyntheticPointerEvent({ point: { x, y }, modifiers: { alt } });
    const click = (x: number, y: number): void => {
      engine.pointer.dispatchPointerDown(pointer(x, y));
      engine.pointer.dispatchPointerUp(pointer(x, y));
    };
    const key = (name: string): void => {
      engine.inputScopes.dispatchKeyDown({
        key: name,
        code: name,
        preventDefault: () => {},
        stopPropagation: () => {}
      } as CanvasKeyboardEvent);
    };
    const text = (row: number, col: number): string =>
      getRunsText(
        engine.documentStore.getNode(id)!.textBlocks!.find((block) => block.slot === `table:cell:${row}:${col}`)!.runs
      );
    return { engine, table, id, click, key, text, pointer };
  }

  it('拖选同步文字块范围，剪切只清空单元格，矩形粘贴按需扩容并可一步撤销', () => {
    const { engine, id, click, text, pointer } = setup();
    engine.pointer.dispatchPointerDown(pointer(20, 15));
    engine.pointer.dispatchPointerMove(pointer(120, 50));
    engine.pointer.dispatchPointerUp(pointer(120, 50));
    expect(engine.session.selectedTextBlocks?.blockIds.size).toBe(4);
    expect(engine.clipboard.cut()?.['text/plain']).toBe('甲\t乙\r\n丙\t丁');
    expect(engine.documentStore.getNode(id)).toBeDefined();
    expect(text(1, 1)).toBe('');
    click(120, 50);
    expect(engine.clipboard.paste({ 'text/plain': '"新\n行"\t右\r\n底\t尾' })).toBe(true);
    expect(engine.documentStore.getNode(id)?.table?.rowCount).toBe(3);
    expect(text(1, 1)).toBe('新\n行');
    expect(text(2, 2)).toBe('尾');
    expect(engine.documentStore.undo()).toBe(true);
    expect(engine.documentStore.getNode(id)?.table?.rowCount).toBe(2);
    engine.destroy();
  });

  it('锁定与只读状态拦截表格命令和分割线写入', () => {
    const { engine, table, id, click, key, text, pointer } = setup();
    click(20, 15);
    engine.documentStore.updateNode(id, { locked: true });
    expect(table.insertRow(undefined, 1, id)).toBe(false);
    key('Delete');
    engine.pointer.dispatchPointerDown(pointer(100, 20));
    engine.pointer.dispatchPointerMove(pointer(140, 20));
    engine.pointer.dispatchPointerUp(pointer(140, 20));
    expect(text(0, 0)).toBe('甲');
    expect(engine.documentStore.getNode(id)?.width).toBe(200);
    engine.documentStore.updateNode(id, { locked: false });
    engine.session.setReadOnly(true);
    expect(table.paste({ 'text/plain': 'a\tb' })).toBe(false);
    expect(text(0, 0)).toBe('甲');
    expect(table.removeColumn(0, 1, id)).toBe(false);
    expect(engine.documentStore.getNode(id)?.table?.columnCount).toBe(2);
    engine.destroy();
  });

  it('F2 进入当前格，编辑态 Tab 移到下一格继续录入', () => {
    const { engine, click, key } = setup();
    click(20, 15);
    key('F2');
    expect(engine.session.textEditing?.blockId).toBe('table:cell:0:0');
    key('Tab');
    expect(engine.session.textEditing?.blockId).toBe('table:cell:0:1');
    engine.destroy();
  });

  it('表达式按普通文字显示和编辑，结构变化不改写内容，复制粘贴保留标点与换行', () => {
    const { engine, table, id, text, click, key } = setup();
    click(20, 15);
    const clipboard = '=SUM(A1:A2)\t含,逗号\r\n"多\n行"\t"含""引号"';
    expect(table.paste({ 'text/plain': clipboard })).toBe(true);
    expect(text(0, 0)).toBe('=SUM(A1:A2)');
    expect(text(1, 0)).toBe('多\n行');
    expect(text(1, 1)).toBe('含"引号');
    const node = engine.documentStore.getNode(id)!;
    const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    const displayed = new TableNodeType().compose(node, { theme }).filter((p) => p.kind === 'text');
    expect(displayed.some((p) => getRunsText(p.runs) === '=SUM(A1:A2)')).toBe(true);
    click(20, 15);
    key('F2');
    expect(engine.session.textEditing?.blockId).toBe('table:cell:0:0');
    key('Escape');
    expect(table.insertRow(0, 1, id)).toBe(true);
    expect(text(1, 0)).toBe('=SUM(A1:A2)');
    expect(table.removeRow(0, 1, id)).toBe(true);
    expect(text(0, 0)).toBe('=SUM(A1:A2)');
    expect(table.insertColumn(0, 1, id)).toBe(true);
    expect(text(0, 1)).toBe('=SUM(A1:A2)');
    expect(table.removeColumn(0, 1, id)).toBe(true);
    click(50, -10);
    expect(table.selectColumns(id)).toBe(true);
    expect(table.copy()?.['text/plain']).toBe('=SUM(A1:A2)\r\n"多\n行"');
    engine.destroy();
  });

  it('拖过单元格角落不会复制内容', () => {
    const { engine, click, text, pointer } = setup();
    click(20, 15);
    engine.pointer.dispatchPointerDown(pointer(100, 36));
    engine.pointer.dispatchPointerMove(pointer(150, 60));
    engine.pointer.dispatchPointerUp(pointer(150, 60));
    expect(text(1, 1)).toBe('丁');
    engine.destroy();
  });

  it('表格经 JSON 保存并在新引擎重开后保留结构、格式、尺寸与文字，继续编辑可撤销', () => {
    const { engine, table, id, pointer } = setup();
    const event = pointer(20, 15);
    engine.pointer.dispatchPointerDown(event);
    engine.pointer.dispatchPointerUp(event);
    expect(table.paste({ 'text/plain': '2\t=A1+3\r\n底\t尾' })).toBe(true);
    table.insertRow(0, 1, id);
    table.clearCellSelection();
    table.setTrackSize(id, 'column', 120);
    engine.pointer.dispatchPointerDown(pointer(20, 86));
    engine.pointer.dispatchPointerMove(pointer(140, 86));
    engine.pointer.dispatchPointerUp(pointer(140, 86));
    table.mergeSelectedCells(id);
    table.setCellFill('#abcdef', id);
    const saved = parseCanvasDocument(JSON.parse(JSON.stringify(engine.documentStore.getView())));
    expect(saved.ok).toBe(true);
    const reopened = new SkyNoteEngine();
    const reopenedTable = new TablePlugin();
    reopened.use(reopenedTable);
    if (saved.ok) {
      reopened.documentStore.replaceContent(saved.value.content, { undoable: false }, saved.value.assets);
      expect(reopened.documentStore.getNode(id)).toEqual(engine.documentStore.getNode(id));
      const block = reopened.documentStore.getNode(id)?.textBlocks?.find((item) => item.slot === 'table:cell:1:1');
      expect(getRunsText(block!.runs)).toBe('=A1+3');
      const original = reopened.documentStore.getNode(id);
      expect(reopenedTable.setTrackSize(id, 'row', 48)).toBe(true);
      expect(reopened.documentStore.undo()).toBe(true);
      expect(reopened.documentStore.getNode(id)).toEqual(original);
    }
    reopened.destroy();
    engine.destroy();
  });

  it('移动行同步迁移文字，合并格内部导航跳到下一个可编辑单元格', () => {
    const { engine, table, id, text, click, key, pointer } = setup();
    click(20, 15);
    expect(table.moveSelectedTracks(id, 'row', 1)).toBe(true);
    expect(text(1, 0)).toBe('甲');
    engine.pointer.dispatchPointerDown(pointer(20, 15));
    engine.pointer.dispatchPointerMove(pointer(120, 15));
    engine.pointer.dispatchPointerUp(pointer(120, 15));
    expect(table.mergeSelectedCells(id)).toBe(true);
    click(120, 15);
    expect(engine.session.selectedTextBlocks?.blockIds).toEqual(new Set(['table:cell:0:0']));
    key('Tab');
    expect(engine.session.textEditing?.blockId).toBe('table:cell:1:0');
    engine.destroy();
  });

  it('Alt 拖拽重排行列，表达式文字在移动及文档 JSON 边界后保持原样', () => {
    const { engine, table, id, text, pointer } = setup();
    const first = pointer(20, 15);
    engine.pointer.dispatchPointerDown(first);
    engine.pointer.dispatchPointerUp(first);
    expect(table.paste({ 'text/plain': '1\t=A1+2\r\n3\t4' })).toBe(true);
    table.clearCellSelection();
    engine.pointer.dispatchPointerDown(pointer(20, 15, true));
    engine.pointer.dispatchPointerMove(pointer(20, 50, true));
    engine.pointer.dispatchPointerUp(pointer(20, 50, true));
    expect(text(0, 0)).toBe('3');
    expect(text(1, 1)).toBe('=A1+2');
    const parsed = parseCanvasDocument(JSON.parse(JSON.stringify(engine.documentStore.getView())));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const restored = parsed.value.content.nodes[id];
      expect(new TableNodeType().validate(restored)).toBeNull();
      expect(restored.textBlocks?.some((block) => getRunsText(block.runs) === '=A1+2')).toBe(true);
    }
    engine.destroy();
  });

  it('从顶部和左侧控制带选择连续行列，Shift 点击扩展同轴范围', () => {
    const { engine, table, id, click, pointer } = setup();
    engine.pointer.dispatchPointerDown(pointer(50, -10));
    engine.pointer.dispatchPointerMove(pointer(150, -10));
    engine.pointer.dispatchPointerUp(pointer(150, -10));
    expect(table.getActiveTrackSelection()).toEqual({ nodeId: id, axis: 'column', start: 0, end: 1 });
    click(-10, 15);
    const extend = new SyntheticPointerEvent({ point: { x: -10, y: 50 }, modifiers: { shift: true } });
    engine.pointer.dispatchPointerDown(extend);
    engine.pointer.dispatchPointerUp(extend);
    expect(table.getActiveTrackSelection()).toEqual({ nodeId: id, axis: 'row', start: 0, end: 1 });
    expect(engine.session.selectedTextBlocks?.blockIds.size).toBe(4);
    engine.destroy();
  });

  it('再次拖动选中的列控制条重排数据，撤销恢复原顺序', () => {
    const { engine, click, pointer, text } = setup();
    click(50, -10);
    engine.pointer.dispatchPointerDown(pointer(50, -10));
    engine.pointer.dispatchPointerMove(pointer(150, -10));
    engine.pointer.dispatchPointerUp(pointer(150, -10));
    expect(text(0, 0)).toBe('乙');
    expect(text(1, 0)).toBe('丁');
    expect(engine.documentStore.undo()).toBe(true);
    expect(text(0, 0)).toBe('甲');
    engine.destroy();
  });

  it('分界位置插入与右侧、底部追加经过同一事务入口', () => {
    const { engine, id, click } = setup();
    click(100, -16);
    expect(engine.documentStore.getNode(id)?.table?.columnCount).toBe(3);
    click(150, 82);
    expect(engine.documentStore.getNode(id)?.table?.rowCount).toBe(3);
    click(310, 54);
    expect(engine.documentStore.getNode(id)?.table?.columnCount).toBe(4);
    expect(engine.documentStore.undo()).toBe(true);
    expect(engine.documentStore.getNode(id)?.table?.columnCount).toBe(3);
    engine.destroy();
  });

  it('行高列宽设置应用于当前范围，整表设置与撤销保持一致', () => {
    const { engine, table, id, click } = setup();
    expect(table.getTrackSizes(id)).toMatchObject({ rowHeight: 36, columnWidth: 100 });
    click(120, 50);
    expect(table.setTrackSize(id, 'row', 60)).toBe(true);
    expect(engine.documentStore.getNode(id)?.height).toBe(96);
    expect(engine.documentStore.getNode(id)?.table?.rows?.[0]?.height).toBeUndefined();
    expect(engine.documentStore.getNode(id)?.table?.rows?.[1]?.height).toBe(60);
    expect(table.setTrackSize(id, 'column', 144)).toBe(true);
    expect(engine.documentStore.getNode(id)?.width).toBe(244);
    expect(table.setTrackSize(id, 'column', 144)).toBe(false);
    expect(engine.documentStore.undo()).toBe(true);
    expect(engine.documentStore.getNode(id)?.width).toBe(200);
    table.clearCellSelection();
    expect(table.getTrackSizes(id)?.rowHeight).toBeNull();
    expect(table.setTrackSize(id, 'row', 48)).toBe(true);
    expect(engine.documentStore.getNode(id)?.table?.rows?.map((row) => row.height)).toEqual([48, 48]);
    expect(engine.documentStore.undo()).toBe(true);
    expect(engine.documentStore.getNode(id)?.height).toBe(96);
    expect(table.setTrackSize(id, 'column', NaN)).toBe(false);
    expect(table.setTrackSize(id, 'row', 0)).toBe(false);
    engine.documentStore.updateNode(id, { locked: true });
    expect(table.setTrackSize(id, 'row', 50)).toBe(false);
    engine.documentStore.updateNode(id, { locked: false });
    engine.session.setReadOnly(true);
    expect(table.setTrackSize(id, 'column', 150)).toBe(false);
    engine.destroy();
  });

  it('适应内容按当前列宽测量换行行高，保留未选行列并可撤销', () => {
    const { engine, table, id, click } = setup();
    click(20, 15);
    expect(table.paste({ 'text/plain': '"甲\n乙\n丙"\t丁\r\n戊\t己' })).toBe(true);
    click(20, 15);
    expect(table.fitRows(id)).toBe(true);
    const height = engine.documentStore.getNode(id)?.table?.rows?.[0]?.height;
    expect(height).toBeGreaterThan(36);
    expect(engine.documentStore.getNode(id)?.table?.rows?.[1]?.height).toBeUndefined();
    expect(engine.documentStore.undo()).toBe(true);
    expect(engine.documentStore.getNode(id)?.height).toBe(72);
    expect(table.fitColumns(id)).toBe(true);
    expect(engine.documentStore.getNode(id)?.table?.columns?.[0]?.width).toBe(32);
    expect(engine.documentStore.getNode(id)?.table?.columns?.[1]?.width).toBeUndefined();
    engine.session.setReadOnly(true);
    expect(table.fitRows(id)).toBe(false);
    engine.destroy();
  });

  it('合并单元格适应列宽时使用完整内容跨度', () => {
    const { engine, table, id, pointer } = setup();
    const first = pointer(20, 15);
    engine.pointer.dispatchPointerDown(first);
    engine.pointer.dispatchPointerUp(first);
    expect(table.paste({ 'text/plain': `${'长'.repeat(40)}\t乙\r\n丙\t丁` })).toBe(true);
    engine.pointer.dispatchPointerDown(pointer(20, 15));
    engine.pointer.dispatchPointerMove(pointer(120, 15));
    engine.pointer.dispatchPointerUp(pointer(120, 15));
    expect(table.mergeSelectedCells(id)).toBe(true);
    expect(table.fitColumns(id)).toBe(true);
    expect(engine.documentStore.getNode(id)?.width).toBeGreaterThanOrEqual(336);
    engine.destroy();
  });

  it('插入提示通过公开订阅提供世界锚点，离开与取消订阅后不保留提示', () => {
    const { engine, table, pointer } = setup();
    const listener = vi.fn();
    const release = table.onControlTooltipChange(listener);
    expect(listener).toHaveBeenLastCalledWith(null);
    engine.pointer.dispatchPointerMove(pointer(100, -16));
    expect(listener).toHaveBeenLastCalledWith({ text: '插入列', anchor: { x: 100, y: -10 } });
    engine.pointer.dispatchPointerMove(pointer(500, 500));
    expect(listener).toHaveBeenLastCalledWith(null);
    release();
    listener.mockClear();
    engine.pointer.dispatchPointerMove(pointer(-16, 36));
    expect(listener).not.toHaveBeenCalled();
    engine.destroy();
  });

  it('双击分割线适应对应列宽，文字插件保持退出状态', () => {
    const { engine, id } = setup();
    const event = new SyntheticPointerEvent({ point: { x: 100, y: 15 }, clickCount: 2 });
    engine.pointer.dispatchPointerDown(event);
    engine.pointer.dispatchPointerUp(event);
    expect(engine.documentStore.getNode(id)?.table?.columns?.[0].width).toBe(32);
    expect(engine.session.textEditing).toBeNull();
    engine.destroy();
  });

  it('行高预览可取消，松手可直接应用最终位置；目标变化后不提交陈旧尺寸', () => {
    const { engine, id, pointer } = setup();
    engine.pointer.dispatchPointerDown(pointer(20, 36));
    engine.pointer.dispatchPointerMove(pointer(20, 60));
    expect(engine.documentStore.getNode(id)?.height).toBe(72);
    engine.pointer.dispatchPointerCancel(pointer(20, 60));
    expect(engine.documentStore.getNode(id)?.height).toBe(72);
    engine.pointer.dispatchPointerDown(pointer(20, 36));
    engine.pointer.dispatchPointerUp(pointer(20, 64));
    expect(engine.documentStore.getNode(id)?.height).toBe(100);
    expect(engine.documentStore.undo()).toBe(true);
    engine.pointer.dispatchPointerDown(pointer(100, 15));
    engine.pointer.dispatchPointerMove(pointer(150, 15));
    engine.documentStore.updateNode(id, { locked: true });
    engine.pointer.dispatchPointerUp(pointer(150, 15));
    expect(engine.documentStore.getNode(id)?.width).toBe(200);
    engine.destroy();
  });

  it('旋转缩放下尺寸预览沿本地轴调整，失焦不写入', () => {
    const { engine, id } = setup();
    engine.documentStore.updateNode(id, { x: 300, y: 100, rotation: 90 });
    engine.session.setViewport({ zoom: 0.5 });
    const matrix = engine.documentStore.entityStore.getWorldTransform(id)!;
    const event = (x: number) => new SyntheticPointerEvent({ point: applyMatrix(matrix, x, 15) });
    engine.pointer.dispatchPointerDown(event(100));
    engine.pointer.dispatchPointerMove(event(140));
    expect(engine.documentStore.getNode(id)?.width).toBe(200);
    engine.pointer.dispatchPointerUp(event(140));
    expect(engine.documentStore.getNode(id)?.width).toBe(240);
    engine.pointer.dispatchPointerDown(event(140));
    engine.pointer.dispatchPointerMove(event(180));
    const plugin = engine.plugins.get(TABLE_PLUGIN_ID) as TablePlugin;
    plugin.onBlur();
    engine.pointer.dispatchPointerUp(event(180));
    expect(engine.documentStore.getNode(id)?.width).toBe(240);
    engine.destroy();
  });

  it('旋转和缩放后仍能在表格外侧选择列与追加列', () => {
    const { engine, table, id } = setup();
    engine.documentStore.updateNode(id, { x: 300, y: 100, rotation: 90 });
    engine.session.setViewport({ zoom: 0.5 });
    const matrix = engine.documentStore.entityStore.getWorldTransform(id)!;
    const clickLocal = (x: number, y: number): void => {
      const event = new SyntheticPointerEvent({ point: applyMatrix(matrix, x, y) });
      engine.pointer.dispatchPointerDown(event);
      engine.pointer.dispatchPointerUp(event);
    };
    clickLocal(50, -20);
    expect(table.getActiveTrackSelection()).toMatchObject({ axis: 'column', start: 0, end: 0 });
    clickLocal(220, 36);
    expect(engine.documentStore.getNode(id)?.table?.columnCount).toBe(3);
    engine.destroy();
  });

  it('已选表格的可见移动把手优先于下方重叠节点', () => {
    const { engine, id, pointer } = setup();
    const otherId = engine.documentStore.createNode({
      nodeType: TABLE_NODE_TYPE,
      x: 0,
      y: -100,
      options: { rowCount: 2, columnCount: 2 }
    })!;
    engine.session.setSelection({ nodeIds: [id], connectorIds: [] });
    engine.pointer.dispatchPointerDown(pointer(100, -34));
    engine.pointer.dispatchPointerMove(pointer(120, -14));
    engine.pointer.dispatchPointerUp(pointer(120, -14));
    expect(engine.documentStore.getNode(id)).toMatchObject({ x: 20, y: 20 });
    expect(engine.documentStore.getNode(otherId)).toMatchObject({ x: 0, y: -100 });
    engine.destroy();
  });
});

describe('TablePlugin Pointer Claiming & InputScope Navigation', () => {
  const nodeType = new TableNodeType();

  function createMockNode(): NodeEntity {
    const content = nodeType.createContent({ rowCount: 2, columnCount: 2 });
    return {
      id: 'table-p1',
      type: 'node',
      nodeType: TABLE_NODE_TYPE,
      x: 100,
      y: 100,
      width: content.width,
      height: content.height,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      table: content.table,
      textBlocks: content.textBlocks
    };
  }

  function createMockContext(mockNode: NodeEntity): {
    ctx: CanvasPluginContext;
    committedPatches: unknown[];
    overlayPrimitives: unknown[];
  } {
    const committedPatches: unknown[] = [];
    let overlayPrimitives: unknown[] = [];
    const selectedNodeIds = new Set<string>();

    const ctx = {
      registerNodeType: vi.fn(),
      registerPointerHooks: vi.fn(),
      registerInputScope: vi.fn(),
      registerClipboardHandler: vi.fn(),
      nodeTypes: { validateNode: vi.fn(() => null) },
      spatial: { search: vi.fn(() => [mockNode.id]) },
      onSessionChange: vi.fn(),
      onDocumentChange: vi.fn(),
      hitTestNode: vi.fn((point) => {
        if (nodeType.hitTest(mockNode, { x: point.x - mockNode.x, y: point.y - mockNode.y })) {
          return mockNode;
        }
        return undefined;
      }),
      entities: {
        getNode: vi.fn((id: string) => (id === mockNode.id ? { entity: mockNode } : undefined)),
        getWorldTransform: vi.fn((id: string) =>
          id === mockNode.id ? { a: 1, b: 0, c: 0, d: 1, e: mockNode.x, f: mockNode.y } : undefined
        )
      },
      session: {
        selectedNodeIds,
        selectedConnectorIds: new Set(),
        tool: 'select',
        viewport: { zoom: 1 },
        theme: deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED }),
        requestTextEditing: vi.fn(),
        setSelectedTextBlocks: vi.fn(),
        setTextEditing: vi.fn(),
        setSelection: vi.fn(({ nodeIds }: { nodeIds: string[] }) => {
          selectedNodeIds.clear();
          nodeIds.forEach((id) => selectedNodeIds.add(id));
        })
      },
      host: {
        capturePointer: vi.fn(),
        releasePointer: vi.fn(),
        setCursor: vi.fn(),
        overlay: {
          setPrimitives: vi.fn((_session, primitives) => {
            overlayPrimitives = primitives;
          }),
          clear: vi.fn(() => {
            overlayPrimitives = [];
          })
        }
      },
      document: {
        commit: vi.fn((opts) => {
          committedPatches.push(opts);
          if (opts.patches?.[0]?.value && typeof opts.patches[0].value === 'object') {
            Object.assign(mockNode, opts.patches[0].value);
          }
          return opts;
        })
      }
    } as unknown as CanvasPluginContext;

    return { ctx, committedPatches, overlayPrimitives };
  }

  it('install 正确注册节点类型、指针钩子与键盘作用域', () => {
    const node = createMockNode();
    const { ctx } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    expect(ctx.registerNodeType).toHaveBeenCalled();
    expect(ctx.registerPointerHooks).toHaveBeenCalledWith(plugin, expect.any(Number));
    expect(ctx.registerInputScope).toHaveBeenCalledWith(plugin);
  });

  it('点击外边框附近不 claimPointer，交由选择工具整体移动', () => {
    const node = createMockNode();
    const { ctx } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    const claimPointer = vi.fn();
    // 点击在 (102, 102)，距离外边框 2px (< 6px 边缘区)
    const event = {
      button: 0,
      point: { x: 102, y: 102 },
      modifiers: {},
      claimPointer
    } as unknown as CanvasPointerEvent;

    plugin.onPointerDown(event);
    expect(claimPointer).not.toHaveBeenCalled();
  });

  it('点击内部单元格执行 claimPointer，选中表格并渲染高亮覆盖层', () => {
    const node = createMockNode();
    const { ctx } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    const claimPointer = vi.fn();
    // 点击在 (150, 120)，属于内部单元格
    const event = {
      button: 0,
      point: { x: 150, y: 120 },
      modifiers: {},
      claimPointer
    } as unknown as CanvasPointerEvent;

    plugin.onPointerDown(event);
    expect(claimPointer).toHaveBeenCalledWith(TABLE_PLUGIN_ID);
    expect(ctx.session.setSelection).toHaveBeenCalledWith({ nodeIds: [node.id], connectorIds: [] });
    expect(ctx.host.overlay.setPrimitives).toHaveBeenCalled();
  });

  it('键盘 Tab 导航并在最末单元格自动追加新行', () => {
    const node = createMockNode();
    const { ctx, committedPatches } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    // 选中最后一行最后一列 [1, 1]
    plugin.onPointerDown({
      button: 0,
      point: { x: 230, y: 150 }, // 对应 [1, 1]
      modifiers: {},
      claimPointer: vi.fn()
    } as unknown as CanvasPointerEvent);

    // 按下 Tab
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const tabEvent = {
      key: 'Tab',
      shiftKey: false,
      preventDefault,
      stopPropagation
    } as unknown as CanvasKeyboardEvent;

    plugin.onKeyDown(tabEvent);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    // 触发了自动追加新行事务
    expect(committedPatches).toHaveLength(1);
    expect((committedPatches[0] as any).label).toBe('表格自动追加行');
  });

  it('Escape 键清除选区并释放覆盖层', () => {
    const node = createMockNode();
    const { ctx } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    plugin.onPointerDown({
      button: 0,
      point: { x: 150, y: 120 },
      modifiers: {},
      claimPointer: vi.fn()
    } as unknown as CanvasPointerEvent);

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const escEvent = {
      key: 'Escape',
      preventDefault,
      stopPropagation
    } as unknown as CanvasKeyboardEvent;

    plugin.onKeyDown(escEvent);
    expect(ctx.host.overlay.clear).toHaveBeenCalled();
  });

  it('顶部独立把手认领指针，选中整表后移动', () => {
    const node = createMockNode();
    const { ctx } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    const claimPointer = vi.fn();
    plugin.onPointerDown({
      button: 0,
      point: { x: 200, y: 66 },
      modifiers: {},
      claimPointer
    } as unknown as CanvasPointerEvent);

    expect(claimPointer).toHaveBeenCalledWith(TABLE_PLUGIN_ID);
    expect(ctx.session.selectedNodeIds.has(node.id)).toBe(true);
  });

  it('拖拽列分割线触发调整列宽事务', () => {
    const node = createMockNode();
    const { ctx, committedPatches } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    const claimPointer = vi.fn();
    // 第 0 列右分割线位于 localX = 100, 即 point.x = 200
    plugin.onPointerDown({
      button: 0,
      pointerId: 1,
      point: { x: 200, y: 120 },
      modifiers: {},
      claimPointer
    } as unknown as CanvasPointerEvent);

    expect(claimPointer).toHaveBeenCalledWith(TABLE_PLUGIN_ID);

    // 拖动 30px 到 x: 250
    plugin.onPointerMove({
      pointerId: 1,
      point: { x: 250, y: 120 },
      modifiers: {},
      claimPointer: vi.fn()
    } as unknown as CanvasPointerEvent);

    // 松手释放
    plugin.onPointerUp({
      pointerId: 1,
      point: { x: 250, y: 120 },
      modifiers: {}
    } as unknown as CanvasPointerEvent);

    expect(committedPatches).toHaveLength(1);
    expect((committedPatches[0] as any).label).toBe('调整列宽');
  });

  it('调整列宽期间只预览，松手后单元格选区与尺寸同步', () => {
    const node = createMockNode();
    const { ctx } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    // 1. 选中单元格 (0, 0)
    plugin.onPointerDown({
      button: 0,
      pointerId: 1,
      point: { x: 150, y: 120 },
      modifiers: {},
      claimPointer: vi.fn()
    } as unknown as CanvasPointerEvent);
    plugin.onPointerUp({
      pointerId: 1,
      point: { x: 150, y: 120 },
      modifiers: {}
    } as unknown as CanvasPointerEvent);

    const initialBounds = plugin.getActiveCellBounds();
    expect(initialBounds).not.toBeNull();
    const initialWidth = initialBounds!.right - initialBounds!.left;

    // 2. 拖拽第 0 列分割线增加列宽 (localX: 100 处于分割线检测点，即 x: 200)
    plugin.onPointerDown({
      button: 0,
      pointerId: 2,
      point: { x: 200, y: 120 },
      modifiers: {},
      claimPointer: vi.fn()
    } as unknown as CanvasPointerEvent);

    // 向右拖动 40px
    plugin.onPointerMove({
      pointerId: 2,
      point: { x: 260, y: 120 },
      modifiers: {},
      claimPointer: vi.fn()
    } as unknown as CanvasPointerEvent);

    // 预览期间不改写文档与正式选区。
    const resizedBounds = plugin.getActiveCellBounds();
    expect(resizedBounds).not.toBeNull();
    const resizedWidth = resizedBounds!.right - resizedBounds!.left;
    expect(resizedWidth).toBe(initialWidth);

    // 释放指针完成列宽调整
    plugin.onPointerUp({
      pointerId: 2,
      point: { x: 260, y: 120 },
      modifiers: {}
    } as unknown as CanvasPointerEvent);

    const finalBounds = plugin.getActiveCellBounds();
    expect(finalBounds).not.toBeNull();
    expect(finalBounds!.right - finalBounds!.left).toBeGreaterThan(initialWidth);
  });

  it('单元格拖拽多选只渲染选区底色与边框', () => {
    const node = createMockNode();
    const { ctx } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    // 点下单元格 (0, 0)
    plugin.onPointerDown({
      button: 0,
      pointerId: 2,
      point: { x: 150, y: 120 },
      modifiers: {},
      claimPointer: vi.fn()
    } as unknown as CanvasPointerEvent);

    // 拖动至单元格 (1, 1)
    plugin.onPointerMove({
      pointerId: 2,
      point: { x: 230, y: 150 },
      modifiers: {},
      claimPointer: vi.fn()
    } as unknown as CanvasPointerEvent);

    plugin.onPointerUp({
      pointerId: 2,
      point: { x: 230, y: 150 },
      modifiers: {}
    } as unknown as CanvasPointerEvent);

    // 内容表格仅显示选区反馈，不提供数据填充柄。
    const setPrimitives = vi.mocked(ctx.host.overlay.setPrimitives);
    expect(setPrimitives).toHaveBeenCalled();
    const selectionCall = setPrimitives.mock.calls
      .slice()
      .reverse()
      .find((call) => call[0] === 'table:selection-overlay');
    expect(selectionCall).toBeDefined();
    const primitives = selectionCall![1];
    expect(primitives).toHaveLength(2);
    expect(primitives.some((p) => p.kind === 'rect' && p.width === 6 && p.height === 6)).toBe(false);
  });

  it('悬停顶部把手与分割线使用统一自绘光标样式', () => {
    const node = createMockNode();
    const { ctx } = createMockContext(node);
    (ctx.host as any).setCursor = vi.fn();
    const plugin = new TablePlugin();
    plugin.install(ctx);

    // 悬停在顶部把手
    plugin.onPointerMove({
      point: { x: 200, y: 66 },
      modifiers: {},
      isClaimed: false
    } as unknown as CanvasPointerEvent);

    expect(ctx.host.setCursor).toHaveBeenCalledWith('grab');
    expect(ctx.host.overlay.setPrimitives).toHaveBeenCalled();

    // 悬停在列分割线 (localX: 100, x: 200)
    plugin.onPointerMove({
      point: { x: 200, y: 120 },
      modifiers: {},
      isClaimed: false
    } as unknown as CanvasPointerEvent);

    expect(ctx.host.setCursor).toHaveBeenCalledWith({ kind: 'resize', angle: 0 });
  });

  it('顶部拖拽把手仅在 hover 或选中时显示，移出未选中状态自动隐藏', () => {
    const node = createMockNode();
    const { ctx } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    const overlayClear = ctx.host.overlay.clear as any;
    const setPrimitives = ctx.host.overlay.setPrimitives as any;

    // 1. 悬停在表格主体区域：显示顶部把手
    plugin.onPointerMove({
      point: { x: 150, y: 120 },
      modifiers: {},
      isClaimed: false
    } as unknown as CanvasPointerEvent);
    expect(setPrimitives).toHaveBeenCalledWith('table:handle-hover', expect.any(Array), expect.any(Object));

    // 2. 移出表格主体且未被选中：把手自动清除
    overlayClear.mockClear();
    plugin.onPointerMove({
      point: { x: 50, y: 50 },
      modifiers: {},
      isClaimed: false
    } as unknown as CanvasPointerEvent);
    expect(overlayClear).toHaveBeenCalledWith('table:handle-hover');

    // 3. 选中表格节点：即使鼠标在画布空白处，把手依然保持显示
    setPrimitives.mockClear();
    ctx.session.setSelection({ nodeIds: [node.id], connectorIds: [] });
    // 触发 onSessionChange 钩子
    const sessionChangeCb = (ctx.onSessionChange as any).mock.calls[0][0];
    sessionChangeCb({
      toggledNodeIds: new Set([node.id]),
      selectionScopeChanged: false
    });
    expect(setPrimitives).toHaveBeenCalledWith('table:handle-hover', expect.any(Array), expect.any(Object));

    // 4. 取消选中表格节点：把手自动清除
    overlayClear.mockClear();
    ctx.session.setSelection({ nodeIds: [], connectorIds: [] });
    sessionChangeCb({
      toggledNodeIds: new Set([node.id]),
      selectionScopeChanged: false
    });
    expect(overlayClear).toHaveBeenCalledWith('table:handle-hover');
  });

  it('公开指令正确响应单元格选区变更与合并/样式操作', () => {
    const node = createMockNode();
    const { ctx, committedPatches } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    const selections: unknown[] = [];
    const unsubscribe = plugin.onCellSelectionChange((sel) => {
      selections.push(sel);
    });

    // 初始监听立即收到当前选区 (null)
    expect(selections).toEqual([null]);

    // 点击单元格 (0, 0)
    plugin.onPointerDown({
      button: 0,
      pointerId: 1,
      point: { x: 150, y: 120 },
      modifiers: {},
      claimPointer: vi.fn()
    } as unknown as CanvasPointerEvent);

    expect(plugin.getActiveCellSelection()).toEqual({
      nodeId: node.id,
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0
    });

    const bounds = plugin.getActiveCellBounds();
    expect(bounds).not.toBeNull();
    expect(bounds!.left).toBe(100);
    expect(bounds!.top).toBe(100);

    // 设置单元格底色
    const fillSuccess = plugin.setCellFill('#FEF08A');
    expect(fillSuccess).toBe(true);
    expect(committedPatches.length).toBeGreaterThan(0);

    // 拖动扩选到 (1, 1)
    plugin.onPointerMove({
      pointerId: 1,
      point: { x: 230, y: 150 },
      modifiers: {},
      claimPointer: vi.fn()
    } as unknown as CanvasPointerEvent);

    expect(plugin.canMergeSelectedCells()).toBe(true);
    const mergeSuccess = plugin.mergeSelectedCells();
    expect(mergeSuccess).toBe(true);

    unsubscribe();
  });

  it('表格旋转后，顶部把手与单元格选区图元使用准确的多边形与包围盒', () => {
    const node = createMockNode();
    node.rotation = 90; // 旋转 90 度
    const { ctx } = createMockContext(node);
    // 模拟旋转 90 度的 worldTransform (cos 90 = 0, sin 90 = 1)
    (ctx.entities.getWorldTransform as any).mockReturnValue({
      a: 0,
      b: 1,
      c: -1,
      d: 0,
      e: node.x,
      f: node.y
    });

    const plugin = new TablePlugin();
    plugin.install(ctx);

    // 1. 悬停在旋转后的表格顶部把手上 (在局部坐标中 y: -10 处，经过旋转后位于世界空间)
    plugin.onPointerMove({
      point: { x: node.x + 10, y: node.y + 50 },
      modifiers: {},
      isClaimed: false
    } as unknown as CanvasPointerEvent);

    const setPrimitives = ctx.host.overlay.setPrimitives as any;
    const handleCall = setPrimitives.mock.calls
      .slice()
      .reverse()
      .find((call: any[]) => call[0] === 'table:handle-hover');
    expect(handleCall).toBeDefined();
    const handlePrimitives = handleCall[1] as any[];
    // 旋转状态下应当生成 polygon 而不是未旋转的水平 rect
    const polygonHandle = handlePrimitives.find((p) => p.kind === 'polygon');
    expect(polygonHandle).toBeDefined();

    // 2. 选中单元格后的选区包围盒：四角旋转投影求解 AABB
    plugin.onPointerDown({
      button: 0,
      pointerId: 1,
      point: { x: node.x, y: node.y + 50 },
      modifiers: {},
      claimPointer: vi.fn()
    } as unknown as CanvasPointerEvent);

    const bounds = plugin.getActiveCellBounds();
    expect(bounds).not.toBeNull();
    // 旋转 90 度后，宽度与高度对调，不会出现负数或退化为单线
    expect(bounds!.right).toBeGreaterThan(bounds!.left);
    expect(bounds!.bottom).toBeGreaterThan(bounds!.top);
  });

  it('未选择单元格时，applyDirectionalBorders 与 clearCellBorders 作用于整张表格', () => {
    const node = createMockNode();
    const { ctx, committedPatches } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    ctx.session.setSelection({ nodeIds: [node.id], connectorIds: [] });
    expect(plugin.getActiveCellSelection()).toBeNull();

    // 1. 未选单元格直接设置整表外边框
    const outsideSuccess = plugin.applyDirectionalBorders('outside', { width: 2, style: 'solid' }, node.id);
    expect(outsideSuccess).toBe(true);
    expect(committedPatches.length).toBeGreaterThan(0);
    const latestCommit = committedPatches[committedPatches.length - 1] as any;
    const latestPatch = latestCommit.patches[0];
    expect(latestPatch.path).toEqual(['content', 'nodes', node.id, 'table', 'cellMeta']);
    const cellMeta = latestPatch.value as Record<string, any>;
    // 检查第 0 行 top 边框和第 1 行 bottom 边框
    expect(cellMeta['0,0']?.borders?.top).toEqual({ width: 2, style: 'solid' });
    expect(cellMeta['1,0']?.borders?.bottom).toEqual({ width: 2, style: 'solid' });

    // 2. 清除边框重置整表
    const clearSuccess = plugin.clearCellBorders(node.id);
    expect(clearSuccess).toBe(true);
  });

  it('支持整表外边框 (outerBorder) 独立开关与切换', () => {
    const node = createMockNode();
    const { ctx, committedPatches } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    ctx.session.setSelection({ nodeIds: [node.id], connectorIds: [] });

    // 默认主题经典网格自带外边框，切换后关闭
    const toggleSuccess = plugin.toggleOuterBorder(node.id);
    expect(toggleSuccess).toBe(true);
    expect(committedPatches.length).toBeGreaterThan(0);
    const patch = (committedPatches[committedPatches.length - 1] as any).patches[0];
    expect(patch.path).toEqual(['content', 'nodes', node.id]);
    expect(patch.value.table.outerBorder).toBe(false);
  });

  it('setOuterBorders 支持独立勾选四边并原子提交', () => {
    const node = createMockNode();
    const { ctx, committedPatches } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    ctx.session.setSelection({ nodeIds: [node.id], connectorIds: [] });

    const success = plugin.setOuterBorders(
      { top: true, bottom: false, left: true, right: false },
      { color: '#EF4444', width: 2, style: 'solid' },
      node.id
    );

    expect(success).toBe(true);
    const patch = (committedPatches[committedPatches.length - 1] as any).patches[0];
    expect(patch.path).toEqual(['content', 'nodes', node.id]);
    expect(patch.value.table.outerBorder).toBe(true);
    expect(patch.value.table.outerBorders).toEqual({
      top: true,
      bottom: false,
      left: true,
      right: false,
      color: '#EF4444',
      width: 2,
      style: 'solid'
    });
  });

  it('setInnerBorders 支持独立设置内部横竖网格线并原子提交', () => {
    const node = createMockNode();
    const { ctx, committedPatches } = createMockContext(node);
    const plugin = new TablePlugin();
    plugin.install(ctx);

    ctx.session.setSelection({ nodeIds: [node.id], connectorIds: [] });

    const success = plugin.setInnerBorders(
      { horizontal: true, vertical: false },
      { color: '#10B981', width: 2, style: 'dashed' },
      node.id
    );

    expect(success).toBe(true);
    const patch = (committedPatches[committedPatches.length - 1] as any).patches[0];
    expect(patch.path).toEqual(['content', 'nodes', node.id]);
    expect(patch.value.table.innerBorder).toBe(true);
    expect(patch.value.table.innerBorders).toEqual({
      horizontal: true,
      vertical: false,
      color: '#10B981',
      width: 2,
      style: 'dashed'
    });
  });
});

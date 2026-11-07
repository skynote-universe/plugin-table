import { expect, it, vi } from 'vitest';
import { SkyNoteEngine, SyntheticPointerEvent, parseCanvasDocument, getRunsText } from '@skynote/core';
import { TablePlugin } from '../src/table-plugin';

it('一万格连续拖动仅绘制预览，不重复校验或提交；松手写入一次，取消不写入', () => {
  const engine = new SkyNoteEngine();
  const table = new TablePlugin();
  engine.use(table);
  const id = engine.documentStore.createNode({
    nodeType: 'table',
    x: 0,
    y: 0,
    options: { rowCount: 100, columnCount: 100, headerRow: false }
  })!;
  const pointer = (x: number, y: number) => new SyntheticPointerEvent({ point: { x, y } });
  const changed = vi.fn();
  const release = engine.documentStore.subscribe(changed);
  const validate = vi.spyOn(engine.nodeTypes, 'validateNode');
  engine.pointer.dispatchPointerDown(pointer(100, 15));
  validate.mockClear();
  const before = engine.documentStore.getNode(id);
  const started = performance.now();
  for (let index = 1; index <= 400; index++) engine.pointer.dispatchPointerMove(pointer(100 + index, 15));
  console.info(`表格10000格400次尺寸预览耗时 ${Math.round(performance.now() - started)}ms（不含浏览器绘制）`);
  expect(changed).not.toHaveBeenCalled();
  expect(validate).not.toHaveBeenCalled();
  expect(engine.documentStore.getNode(id)).toBe(before);
  engine.pointer.dispatchPointerUp(pointer(550, 15));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(engine.documentStore.getNode(id)?.table?.columns?.[0]?.width).toBe(550);
  changed.mockClear();
  engine.pointer.dispatchPointerDown(pointer(550, 15));
  engine.pointer.dispatchPointerMove(pointer(600, 15));
  engine.pointer.dispatchPointerCancel(pointer(600, 15));
  expect(changed).not.toHaveBeenCalled();
  expect(engine.documentStore.getNode(id)?.table?.columns?.[0]?.width).toBe(550);
  expect(engine.documentStore.undo()).toBe(true);
  expect(engine.documentStore.getNode(id)?.width).toBe(10000);
  release();
  validate.mockRestore();
  engine.destroy();
});

it('最大容量的建表、全选、复制、保存重开，以及超限失败均保持数据完整', () => {
  const started = performance.now();
  const engine = new SkyNoteEngine();
  const table = new TablePlugin();
  engine.use(table);
  const id = engine.documentStore.createNode({
    nodeType: 'table',
    x: 0,
    y: 0,
    options: {
      rowCount: 100,
      columnCount: 100,
      headerRow: false,
      cells: Array.from({ length: 100 }, (_, row) => Array.from({ length: 100 }, (_, col) => `${row}:${col}`))
    }
  })!;
  const pointer = (x: number, y: number) => new SyntheticPointerEvent({ point: { x, y } });
  engine.pointer.dispatchPointerDown(pointer(20, 15));
  engine.pointer.dispatchPointerMove(pointer(9950, 3580));
  engine.pointer.dispatchPointerUp(pointer(9950, 3580));
  expect(engine.session.selectedTextBlocks?.blockIds.size).toBe(10_000);
  const copied = table.copy()?.['text/plain'];
  expect(copied).toContain('99:99');
  const event = pointer(9950, 3580);
  engine.pointer.dispatchPointerDown(event);
  engine.pointer.dispatchPointerUp(event);
  const rejection = vi.fn();
  const release = table.onOperationRejected(rejection);
  const before = JSON.stringify(engine.documentStore.getView());
  expect(table.paste({ 'text/plain': '新\t越界' })).toBe(true); // 输入已被消费，失败由公开事件报告。
  expect(rejection).toHaveBeenLastCalledWith('capacity');
  expect(table.insertRow(undefined, 1, id)).toBe(false);
  expect(rejection).toHaveBeenCalledTimes(2);
  expect(table.paste({ 'text/plain': '"未闭合\t右' })).toBe(true);
  expect(rejection).toHaveBeenLastCalledWith('invalid-paste');
  expect(JSON.stringify(engine.documentStore.getView())).toBe(before);
  release();
  const parsed = parseCanvasDocument(JSON.parse(before));
  expect(parsed.ok).toBe(true);
  const reopened = new SkyNoteEngine();
  const reopenedTable = new TablePlugin();
  reopened.use(reopenedTable);
  if (parsed.ok) {
    reopened.documentStore.replaceContent(parsed.value.content, { undoable: false }, parsed.value.assets);
    const last = reopened.documentStore.getNode(id)?.textBlocks?.find((block) => block.slot === 'table:cell:99:99');
    expect(getRunsText(last!.runs)).toBe('99:99');
    expect(reopened.documentStore.getNode(id)?.textBlocks).toHaveLength(10_000);
  }
  console.info(`表格10000格模型流程耗时 ${Math.round(performance.now() - started)}ms（不含浏览器绘制）`);
  reopened.destroy();
  engine.destroy();
});

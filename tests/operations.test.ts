import { describe, expect, it } from 'vitest';
import type { NodeEntity } from '@skynote/core';
import { TableNodeType } from '../src/table-node';
import {
  insertRowsOperation,
  removeRowsOperation,
  insertColumnsOperation,
  removeColumnsOperation,
  resizeRowOperation,
  resizeColumnOperation,
  mergeCellsOperation,
  unmergeCellsOperation,
  setCellBordersOperation,
  clearCellBordersOperation,
  setOuterBorderOperation,
  setTableThemeOperation,
  toggleBandedRowsOperation,
  toggleTotalRowOperation,
  distributeColumnsOperation,
  distributeRowsOperation,
  setCellAlignmentOperation,
  setCellDiagonalOperation,
  setOuterBordersOperation,
  setInnerBordersOperation,
  toggleInnerBorderOperation,
  toggleCellDiagonalOperation,
  applyDirectionalBordersOperation,
  toggleOuterBorderOperation
} from '../src/operations';
import { TABLE_NODE_TYPE } from '../src/types';

describe('Table Atomic Operations & Patch Generators', () => {
  const nodeType = new TableNodeType();

  function createMockTableNode(rowCount = 3, columnCount = 3): NodeEntity {
    const content = nodeType.createContent({ rowCount, columnCount });
    return {
      id: 'table-test',
      type: 'node',
      nodeType: TABLE_NODE_TYPE,
      x: 0,
      y: 0,
      width: content.width,
      height: content.height,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      table: content.table,
      textBlocks: content.textBlocks
    };
  }

  it('insertRowsOperation 成功插入新行，平移受影响区域并继承相邻行的行高、单元格样式与文字样式', () => {
    let node = createMockTableNode(3, 3);
    // 给第 1 行设置自定义行高、底色、对齐与文本字号
    node = resizeRowOperation(node, 1, 52)!.updatedNode;
    node = setCellAlignmentOperation(
      node,
      { startRow: 1, startCol: 0, endRow: 1, endCol: 2 },
      'right',
      'bottom'
    ).updatedNode;
    node = {
      ...node,
      table: {
        ...node.table!,
        cellMeta: {
          ...node.table?.cellMeta,
          '1,0': { ...node.table?.cellMeta?.['1,0'], fill: '$yellow' }
        }
      }
    };

    // 在第 2 行位置 (即第 1 行下方) 插入 1 行
    const result = insertRowsOperation(node, 2, 1);

    expect(result.updatedNode.table?.rowCount).toBe(4);
    expect(result.updatedNode.textBlocks).toHaveLength(4 * 3);

    // 新增的第 2 行继承相邻第 1 行的行高 (52)、单元格底色 ($yellow)、对齐 (right/bottom) 与 TextBlock 样式
    expect(result.updatedNode.table?.rows?.[2]?.height).toBe(52);
    expect(result.updatedNode.table?.cellMeta?.['2,0']?.fill).toBe('$yellow');
    expect(result.updatedNode.table?.cellMeta?.['2,0']?.align).toBe('right');
    expect(result.updatedNode.table?.cellMeta?.['2,0']?.verticalAlign).toBe('bottom');
    const insertedBlock = result.updatedNode.textBlocks?.find(
      (b) => b.slot === 'table:cell:2,0' || b.slot === 'table:cell:2:0'
    );
    expect(insertedBlock?.style?.textAlign).toBe('right');
    expect(insertedBlock?.style?.verticalAlign).toBe('bottom');

    // 补丁是合法的 set 补丁
    expect(result.patch.op).toBe('set');
    expect(result.patch.path).toEqual(['content', 'nodes', 'table-test']);
  });

  it('removeRowsOperation 成功删除指定行并维持至少 1 行底线', () => {
    const node = createMockTableNode(3, 3);
    const result = removeRowsOperation(node, 1, 1);
    expect(result).not.toBeNull();
    expect(result!.updatedNode.table?.rowCount).toBe(2);
    expect(result!.updatedNode.textBlocks).toHaveLength(2 * 3);

    // 尝试删除全部行，必须返回 null 拒绝
    const invalidRemove = removeRowsOperation(node, 0, 3);
    expect(invalidRemove).toBeNull();
  });

  it('insertColumnsOperation 成功插入新列并继承相邻列的列宽、单元格样式与文字样式', () => {
    let node = createMockTableNode(2, 2);
    node = resizeColumnOperation(node, 1, 160)!.updatedNode;
    node = setCellAlignmentOperation(
      node,
      { startRow: 0, startCol: 1, endRow: 1, endCol: 1 },
      'center',
      'middle'
    ).updatedNode;
    node = {
      ...node,
      table: {
        ...node.table!,
        cellMeta: {
          ...node.table?.cellMeta,
          '1,1': { ...node.table?.cellMeta?.['1,1'], fill: '$blue' }
        }
      }
    };

    const result = insertColumnsOperation(node, 2, 1);

    expect(result.updatedNode.table?.columnCount).toBe(3);
    expect(result.updatedNode.textBlocks).toHaveLength(2 * 3);
    expect(result.updatedNode.table?.columns?.[2]?.width).toBe(160);
    expect(result.updatedNode.table?.cellMeta?.['1,2']?.fill).toBe('$blue');
    expect(result.updatedNode.table?.cellMeta?.['1,2']?.align).toBe('center');
    const insertedBlock = result.updatedNode.textBlocks?.find((b) => b.slot === 'table:cell:1:2');
    expect(insertedBlock?.style?.textAlign).toBe('center');
  });

  it('removeColumnsOperation 成功删除指定列', () => {
    const node = createMockTableNode(2, 3);
    const result = removeColumnsOperation(node, 0, 1);

    expect(result).not.toBeNull();
    expect(result!.updatedNode.table?.columnCount).toBe(2);
    expect(result!.updatedNode.textBlocks).toHaveLength(2 * 2);
  });

  it('resizeRowOperation 与 resizeColumnOperation 正确更新尺寸与总包围盒', () => {
    const node = createMockTableNode(3, 3);
    const origH = node.height;
    const origW = node.width;

    const rowResized = resizeRowOperation(node, 1, 60);
    expect(rowResized).not.toBeNull();
    expect(rowResized!.updatedNode.height).toBe(origH + (60 - 36));

    const colResized = resizeColumnOperation(node, 0, 150);
    expect(colResized).not.toBeNull();
    expect(colResized!.updatedNode.width).toBe(origW + (150 - 100));
  });

  it('mergeCellsOperation 与 unmergeCellsOperation 正确管理合并范围', () => {
    const node = createMockTableNode(4, 4);

    // 合并 [1, 1] 到 [2, 2]
    const merged = mergeCellsOperation(node, { startRow: 1, startCol: 1, endRow: 2, endCol: 2 });
    expect(merged).not.toBeNull();
    expect(merged!.updatedNode.table?.merges).toHaveLength(1);
    expect(merged!.updatedNode.table?.merges?.[0]).toEqual({
      startRow: 1,
      startCol: 1,
      endRow: 2,
      endCol: 2
    });

    // 取消合并
    const unmerged = unmergeCellsOperation(merged!.updatedNode, 1, 1);
    expect(unmerged).not.toBeNull();
    expect(unmerged!.updatedNode.table?.merges).toBeUndefined();
  });

  it('setCellBordersOperation 与 clearCellBordersOperation 正确读写单元格自定义边框', () => {
    const node = createMockTableNode(2, 2);
    const bordered = setCellBordersOperation(
      node,
      { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
      { bottom: { color: '#0066FF', width: 2, style: 'solid' } }
    );

    expect(bordered.updatedNode.table?.cellMeta?.['0,0']?.borders?.bottom).toEqual({
      color: '#0066FF',
      width: 2,
      style: 'solid'
    });
    expect(bordered.updatedNode.table?.cellMeta?.['0,1']?.borders?.bottom).toEqual({
      color: '#0066FF',
      width: 2,
      style: 'solid'
    });

    const cleared = clearCellBordersOperation(bordered.updatedNode, {
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0
    });
    expect(cleared.updatedNode.table?.cellMeta?.['0,0']?.borders).toBeUndefined();
    expect(cleared.updatedNode.table?.cellMeta?.['0,1']?.borders?.bottom).toBeDefined();
  });

  it('setOuterBorderOperation 正确设置节点外边框样式', () => {
    const node = createMockTableNode(2, 2);
    const res = setOuterBorderOperation(node, {
      color: '#22C55E',
      width: 3,
      style: 'dashed'
    });

    expect(res.updatedNode.style?.stroke).toBe('#22C55E');
    expect(res.updatedNode.style?.strokeWidth).toBe(3);
    expect(res.updatedNode.style?.strokeDashArray).toEqual([4, 4]);
  });

  it('setTableThemeOperation 与 toggleBandedRows / toggleTotalRow 正确更新持久化字段', () => {
    const node = createMockTableNode(3, 3);
    const banded = toggleBandedRowsOperation(node);
    expect(banded.updatedNode.table?.bandedRows).toBe(true);
    const unbanded = toggleBandedRowsOperation(banded.updatedNode, false);
    expect(unbanded.updatedNode.table?.bandedRows).toBe(false);

    const themed = setTableThemeOperation(node, 'business-blue');
    expect(themed.updatedNode.table?.themeId).toBe('business-blue');
    expect(themed.updatedNode.table?.outerBorder).toBeUndefined();

    // 主题色切换保留用户已关闭的边框，框线由独立预设控制。
    const nodeWithClosedBorders: NodeEntity = {
      ...node,
      table: {
        ...node.table!,
        outerBorder: false,
        cellMeta: {
          ['0,0']: { borders: { top: { width: 0 } } },
          ['2,0']: { borders: { bottom: { width: 0 } } }
        }
      }
    };
    const cleanedTheme = setTableThemeOperation(nodeWithClosedBorders, 'plain-grid');
    expect(cleanedTheme.updatedNode.table?.outerBorder).toBe(false);
    expect(cleanedTheme.updatedNode.table?.cellMeta?.['0,0']?.borders?.top).toEqual({ width: 0 });
    expect(cleanedTheme.updatedNode.table?.cellMeta?.['2,0']?.borders?.bottom).toEqual({ width: 0 });

    const totaled = toggleTotalRowOperation(node);
    expect(totaled.updatedNode.table?.totalRow).toBe(true);
  });

  it('distributeColumnsOperation 与 distributeRowsOperation 均分行列宽高', () => {
    const node = createMockTableNode(3, 3);
    const distCols = distributeColumnsOperation(node);
    expect(distCols.updatedNode.table?.columns).toHaveLength(3);
    expect(distCols.updatedNode.table?.columns?.[0].width).toBe(100);
    expect(distCols.updatedNode.table?.columns?.[1].width).toBe(100);

    const distRows = distributeRowsOperation(node);
    expect(distRows.updatedNode.table?.rows).toHaveLength(3);
    expect(distRows.updatedNode.table?.rows?.[0].height).toBe(36);
  });

  it('setCellAlignmentOperation 正确设置对齐并同步 textBlocks', () => {
    const node = createMockTableNode(2, 2);
    const res = setCellAlignmentOperation(node, { startRow: 0, startCol: 0, endRow: 1, endCol: 0 }, 'center', 'middle');
    expect(res.updatedNode.table?.cellMeta?.['0,0']?.align).toBe('center');
    expect(res.updatedNode.table?.cellMeta?.['0,0']?.verticalAlign).toBe('middle');
    expect(res.updatedNode.table?.cellMeta?.['1,0']?.align).toBe('center');

    const block00 = res.updatedNode.textBlocks?.find((b) => b.slot === 'table:cell:0:0');
    expect(block00?.style?.textAlign).toBe('center');
    expect(block00?.style?.verticalAlign).toBe('middle');
  });

  it('toggleCellDiagonalOperation 循环切换斜线表头', () => {
    const node = createMockTableNode(2, 2);
    const d1 = toggleCellDiagonalOperation(node, 0, 0);
    expect(d1.updatedNode.table?.cellMeta?.['0,0']?.diagonal).toBe('down');

    const d2 = toggleCellDiagonalOperation(d1.updatedNode, 0, 0);
    expect(d2.updatedNode.table?.cellMeta?.['0,0']?.diagonal).toBe('up');

    const d3 = toggleCellDiagonalOperation(d2.updatedNode, 0, 0);
    expect(d3.updatedNode.table?.cellMeta?.['0,0']?.diagonal).toBeUndefined();
  });

  it('setCellDiagonalOperation 设置独立颜色、样式与粗细，并在 toggle 时予以保留', () => {
    const node = createMockTableNode(2, 2);
    const configured = setCellDiagonalOperation(node, 0, 0, {
      direction: 'down',
      color: '#3B82F6',
      width: 2,
      style: 'dashed'
    });
    expect(configured.updatedNode.table?.cellMeta?.['0,0']?.diagonal).toEqual({
      direction: 'down',
      color: '#3B82F6',
      width: 2,
      style: 'dashed'
    });

    // 切换方向时，保留原设定的颜色、宽度与样式
    const toggled = toggleCellDiagonalOperation(configured.updatedNode, 0, 0);
    expect(toggled.updatedNode.table?.cellMeta?.['0,0']?.diagonal).toEqual({
      direction: 'up',
      color: '#3B82F6',
      width: 2,
      style: 'dashed'
    });

    // 清除斜线
    const cleared = setCellDiagonalOperation(toggled.updatedNode, 0, 0, null);
    expect(cleared.updatedNode.table?.cellMeta?.['0,0']?.diagonal).toBeUndefined();
  });

  it('applyDirectionalBordersOperation 精确控制定向框线', () => {
    const node = createMockTableNode(3, 3);
    const range = { startRow: 0, startCol: 0, endRow: 2, endCol: 2 };
    const border = { color: '#FF0000', width: 2, style: 'solid' as const };

    // 仅设置顶部边框
    const topOnly = applyDirectionalBordersOperation(node, range, 'top', border);
    expect(topOnly.updatedNode.table?.cellMeta?.['0,0']?.borders?.top).toEqual(border);
    expect(topOnly.updatedNode.table?.cellMeta?.['0,1']?.borders?.top).toEqual(border);
    expect(topOnly.updatedNode.table?.cellMeta?.['1,0']?.borders?.top).toBeUndefined();

    // 外侧边框 (outside)
    const outside = applyDirectionalBordersOperation(node, range, 'outside', border);
    expect(outside.updatedNode.table?.cellMeta?.['0,0']?.borders?.top).toEqual(border);
    expect(outside.updatedNode.table?.cellMeta?.['0,0']?.borders?.left).toEqual(border);
    expect(outside.updatedNode.table?.cellMeta?.['2,2']?.borders?.bottom).toEqual(border);
    expect(outside.updatedNode.table?.cellMeta?.['2,2']?.borders?.right).toEqual(border);
    // 内部单元格无外框
    expect(outside.updatedNode.table?.cellMeta?.['1,1']?.borders).toBeUndefined();

    // 清除边框
    const cleared = applyDirectionalBordersOperation(outside.updatedNode, range, 'clear');
    expect(cleared.updatedNode.table?.cellMeta?.['0,0']?.borders).toBeUndefined();
  });

  it('toggleOuterBorderOperation 切换外框线并彻底清理四周自定义外侧框线', () => {
    const node = createMockTableNode(3, 3);
    const range = { startRow: 0, startCol: 0, endRow: 2, endCol: 2 };
    const border = { color: '#0000FF', width: 2, style: 'solid' as const };
    const withOutside = applyDirectionalBordersOperation(node, range, 'outside', border);
    expect(withOutside.updatedNode.table?.cellMeta?.['0,0']?.borders?.top).toEqual(border);

    // 关闭外边框
    const closed = toggleOuterBorderOperation(withOutside.updatedNode, false);
    expect(closed.updatedNode.table?.outerBorder).toBe(false);
    expect(closed.patch.path).toEqual(['content', 'nodes', node.id]);
    // 四周外侧框线已被清除
    expect(closed.updatedNode.table?.cellMeta?.['0,0']?.borders?.top).toBeUndefined();
    expect(closed.updatedNode.table?.cellMeta?.['2,2']?.borders?.bottom).toBeUndefined();
  });

  it('setOuterBordersOperation 与 setInnerBordersOperation 在表格层级独立存储内外边框，不污染单元格 cellMeta', () => {
    const node = createMockTableNode(3, 3);
    const border = { color: '#10B981', width: 2, style: 'dashed' as const };

    // 1. 仅开启上和下，关闭左和右外边框
    const result = setOuterBordersOperation(node, { top: true, bottom: true, left: false, right: false }, border);

    expect(result.updatedNode.table?.outerBorder).toBe(true);
    expect(result.updatedNode.table?.outerBorders).toEqual({
      top: true,
      bottom: true,
      left: false,
      right: false,
      color: '#10B981',
      width: 2,
      style: 'dashed'
    });
    expect(result.updatedNode.table?.cellMeta).toBeUndefined();

    // 2. 独立设置内边框 (开启内部横线，关闭内部竖线)
    const innerResult = setInnerBordersOperation(
      result.updatedNode,
      { horizontal: true, vertical: false },
      { color: '#3B82F6', width: 1, style: 'dotted' }
    );
    expect(innerResult.updatedNode.table?.innerBorder).toBe(true);
    expect(innerResult.updatedNode.table?.innerBorders).toEqual({
      horizontal: true,
      vertical: false,
      color: '#3B82F6',
      width: 1,
      style: 'dotted'
    });

    // 3. 切换内边框总开关为关闭
    const innerOff = toggleInnerBorderOperation(innerResult.updatedNode, false);
    expect(innerOff.updatedNode.table?.innerBorder).toBe(false);
    expect(innerOff.updatedNode.table?.innerBorders?.horizontal).toBe(false);
    expect(innerOff.updatedNode.table?.innerBorders?.vertical).toBe(false);

    // 单步原子 patch 验证
    expect(result.patch.path).toEqual(['content', 'nodes', node.id]);
  });
});

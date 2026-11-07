/**
 * @file operations.ts
 * @description 表格行列增删、宽高调整与合并单元格的纯函数原子事务补丁生成器
 */

import type { CanvasPatch, NodeEntity, TextBlock } from '@skynote/core';
import {
  MIN_COLUMN_WIDTH,
  MIN_ROW_HEIGHT,
  cellKey,
  parseCellKey,
  parseTableCellSlot,
  tableCellSlot,
  type TableBorderSide,
  type TableCellBorders,
  type TableCellDiagonal,
  type TableCellDiagonalDirection,
  type TableCellMeta,
  type TableCellOverflowMode,
  type TableColumnMeta,
  type TableInnerBorderConfig,
  type TableMergeRange,
  type TableNodeFields,
  type TableOuterBorderConfig,
  type TableOuterSides,
  type TableGridStyle,
  type TableRowMeta
} from './types';
import { computeTableTracks } from './layout';
import { tableThemeRegistry } from './themes';
import { getTableGridStyle } from './grid-styles';
/** 获取表格节点的安全数据结构 */
function getTableFields(node: Readonly<NodeEntity>): TableNodeFields {
  return (
    node.table ?? {
      rowCount: 1,
      columnCount: 1
    }
  );
}

/** 插入单行或多行 (自动继承相邻行的行高、单元格底色/对齐/边框及文本样式) */
export function insertRowsOperation(
  node: Readonly<NodeEntity>,
  atIndex: number,
  count = 1
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const rowCount = table.rowCount;
  const colCount = table.columnCount;
  const safeIndex = Math.max(0, Math.min(atIndex, rowCount));
  const safeCount = Math.max(1, count);

  const isHeaderRow = table.headerRow ?? true;
  const refRow = safeIndex === 0 ? 0 : safeIndex === 1 && rowCount > 1 && isHeaderRow ? 1 : Math.max(0, safeIndex - 1);
  const inheritedRowMeta: TableRowMeta = table.rows?.[refRow] ? { ...table.rows[refRow] } : {};

  // 1. 迁移 rows 稀疏元数据并让新增行继承相邻行高
  const nextRows: TableRowMeta[] = [];
  for (let r = 0; r < rowCount; r++) {
    if (r === safeIndex) {
      for (let k = 0; k < safeCount; k++) nextRows.push({ ...inheritedRowMeta });
    }
    nextRows.push(table.rows?.[r] ?? {});
  }
  if (safeIndex === rowCount) {
    for (let k = 0; k < safeCount; k++) nextRows.push({ ...inheritedRowMeta });
  }

  // 2. 迁移 cellMeta 并让新增行继承相邻行的单元格样式 (底色、对齐、局部边框)
  const nextCellMeta: Record<string, TableCellMeta> = {};
  if (table.cellMeta) {
    for (const [key, meta] of Object.entries(table.cellMeta)) {
      const pos = parseCellKey(key);
      if (!pos) continue;
      const r = pos.row >= safeIndex ? pos.row + safeCount : pos.row;
      nextCellMeta[cellKey(r, pos.col)] = meta;
    }
    for (let c = 0; c < colCount; c++) {
      const refMeta = table.cellMeta[cellKey(refRow, c)];
      if (!refMeta) continue;
      const inheritedCellMeta: TableCellMeta = {
        ...(refMeta.fill !== undefined ? { fill: refMeta.fill } : {}),
        ...(refMeta.align !== undefined ? { align: refMeta.align } : {}),
        ...(refMeta.verticalAlign !== undefined ? { verticalAlign: refMeta.verticalAlign } : {}),
        ...(refMeta.overflow !== undefined ? { overflow: refMeta.overflow } : {}),
        ...(refMeta.borders !== undefined ? { borders: { ...refMeta.borders } } : {})
      };
      if (Object.keys(inheritedCellMeta).length > 0) {
        for (let r = safeIndex; r < safeIndex + safeCount; r++) {
          nextCellMeta[cellKey(r, c)] = { ...inheritedCellMeta };
        }
      }
    }
  }

  // 3. 迁移与新增 TextBlocks (继承相邻行对应列的字体排版样式)
  const nextBlocks: TextBlock[] = [];
  const existingMap = new Map<string, TextBlock>();
  for (const block of node.textBlocks ?? []) {
    if (block.slot) existingMap.set(block.slot, block);
  }

  for (let r = 0; r < rowCount + safeCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const currentSlot = tableCellSlot(r, c);
      if (r >= safeIndex && r < safeIndex + safeCount) {
        const refBlock = existingMap.get(tableCellSlot(refRow, c));
        nextBlocks.push({
          id: currentSlot,
          slot: currentSlot,
          runs: [{ text: '' }],
          ...(refBlock?.style ? { style: { ...refBlock.style } } : {})
        });
      } else {
        const oldRow = r >= safeIndex + safeCount ? r - safeCount : r;
        const oldSlot = tableCellSlot(oldRow, c);
        const oldBlock = existingMap.get(oldSlot);
        if (oldBlock) {
          nextBlocks.push({
            ...oldBlock,
            id: currentSlot,
            slot: currentSlot
          });
        } else {
          nextBlocks.push({
            id: currentSlot,
            slot: currentSlot,
            runs: [{ text: '' }]
          });
        }
      }
    }
  }

  // 4. 迁移合并单元格
  const nextMerges: TableMergeRange[] = [];
  for (const merge of table.merges ?? []) {
    if (merge.startRow >= safeIndex) {
      nextMerges.push({
        ...merge,
        startRow: merge.startRow + safeCount,
        endRow: merge.endRow + safeCount
      });
    } else if (merge.endRow >= safeIndex) {
      nextMerges.push({
        ...merge,
        endRow: merge.endRow + safeCount
      });
    } else {
      nextMerges.push(merge);
    }
  }

  const nextTable: TableNodeFields = {
    ...table,
    rowCount: rowCount + safeCount,
    rows: nextRows,
    cellMeta: nextCellMeta,
    merges: nextMerges.length > 0 ? nextMerges : undefined
  };

  const tracks = computeTableTracks(nextTable.rowCount, nextTable.columnCount, nextTable.rows, nextTable.columns);
  const updatedNode: NodeEntity = {
    ...node,
    height: tracks.totalHeight,
    table: nextTable,
    textBlocks: nextBlocks
  };

  return { updatedNode, patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode } };
}

/** 删除单行或多行 (表格必须至少保留一行) */
export function removeRowsOperation(
  node: Readonly<NodeEntity>,
  atIndex: number,
  count = 1
): { updatedNode: NodeEntity; patch: CanvasPatch } | null {
  const table = getTableFields(node);
  const rowCount = table.rowCount;
  const colCount = table.columnCount;
  if (count <= 0 || count >= rowCount || rowCount <= 1) return null;
  const safeCount = count;
  const safeIndex = Math.max(0, Math.min(atIndex, rowCount - safeCount));
  const endIndex = safeIndex + safeCount;

  // 1. 迁移 rows 稀疏元数据
  const nextRows: TableRowMeta[] = [];
  for (let r = 0; r < rowCount; r++) {
    if (r >= safeIndex && r < endIndex) continue;
    nextRows.push(table.rows?.[r] ?? {});
  }

  // 2. 迁移 cellMeta
  const nextCellMeta: Record<string, TableCellMeta> = {};
  if (table.cellMeta) {
    for (const [key, meta] of Object.entries(table.cellMeta)) {
      const pos = parseCellKey(key);
      if (!pos || (pos.row >= safeIndex && pos.row < endIndex)) continue;
      const r = pos.row >= endIndex ? pos.row - safeCount : pos.row;
      nextCellMeta[cellKey(r, pos.col)] = meta;
    }
  }

  // 3. 迁移 TextBlocks
  const nextBlocks: TextBlock[] = [];
  const existingMap = new Map<string, TextBlock>();
  for (const block of node.textBlocks ?? []) {
    if (block.slot) existingMap.set(block.slot, block);
  }

  for (let r = 0; r < rowCount - safeCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const currentSlot = tableCellSlot(r, c);
      const oldRow = r >= safeIndex ? r + safeCount : r;
      const oldSlot = tableCellSlot(oldRow, c);
      const oldBlock = existingMap.get(oldSlot);
      nextBlocks.push({
        ...(oldBlock ?? { runs: [{ text: '' }] }),
        id: currentSlot,
        slot: currentSlot
      });
    }
  }

  // 4. 迁移合并单元格
  const nextMerges: TableMergeRange[] = [];
  for (const merge of table.merges ?? []) {
    // 整个合并块完全被删除
    if (merge.startRow >= safeIndex && merge.endRow < endIndex) continue;

    let startRow = merge.startRow;
    let endRow = merge.endRow;

    if (startRow >= endIndex) {
      startRow -= safeCount;
      endRow -= safeCount;
    } else if (startRow >= safeIndex && startRow < endIndex) {
      startRow = safeIndex;
      endRow -= safeCount;
    } else if (endRow >= safeIndex) {
      endRow = Math.max(startRow, endRow - safeCount);
    }

    if (startRow === endRow && merge.startCol === merge.endCol) continue;
    nextMerges.push({ ...merge, startRow, endRow });
  }

  const nextTable: TableNodeFields = {
    ...table,
    rowCount: rowCount - safeCount,
    rows: nextRows,
    cellMeta: nextCellMeta,
    merges: nextMerges.length > 0 ? nextMerges : undefined
  };

  const tracks = computeTableTracks(nextTable.rowCount, nextTable.columnCount, nextTable.rows, nextTable.columns);
  const updatedNode: NodeEntity = {
    ...node,
    height: tracks.totalHeight,
    table: nextTable,
    textBlocks: nextBlocks
  };

  return { updatedNode, patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode } };
}

/** 插入单列或多列 (自动继承相邻列的列宽、单元格底色/对齐/边框及文本样式) */
export function insertColumnsOperation(
  node: Readonly<NodeEntity>,
  atIndex: number,
  count = 1
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const rowCount = table.rowCount;
  const colCount = table.columnCount;
  const safeIndex = Math.max(0, Math.min(atIndex, colCount));
  const safeCount = Math.max(1, count);

  const isHeaderCol = table.headerColumn ?? false;
  const refCol = safeIndex === 0 ? 0 : safeIndex === 1 && colCount > 1 && isHeaderCol ? 1 : Math.max(0, safeIndex - 1);
  const inheritedColMeta: TableColumnMeta = table.columns?.[refCol] ? { ...table.columns[refCol] } : {};

  // 1. 迁移 columns 稀疏元数据并让新增列继承相邻列宽
  const nextCols: TableColumnMeta[] = [];
  for (let c = 0; c < colCount; c++) {
    if (c === safeIndex) {
      for (let k = 0; k < safeCount; k++) nextCols.push({ ...inheritedColMeta });
    }
    nextCols.push(table.columns?.[c] ?? {});
  }
  if (safeIndex === colCount) {
    for (let k = 0; k < safeCount; k++) nextCols.push({ ...inheritedColMeta });
  }

  // 2. 迁移 cellMeta 并让新增列继承相邻列的单元格样式 (底色、对齐、局部边框)
  const nextCellMeta: Record<string, TableCellMeta> = {};
  if (table.cellMeta) {
    for (const [key, meta] of Object.entries(table.cellMeta)) {
      const pos = parseCellKey(key);
      if (!pos) continue;
      const c = pos.col >= safeIndex ? pos.col + safeCount : pos.col;
      nextCellMeta[cellKey(pos.row, c)] = meta;
    }
    for (let r = 0; r < rowCount; r++) {
      const refMeta = table.cellMeta[cellKey(r, refCol)];
      if (!refMeta) continue;
      const inheritedCellMeta: TableCellMeta = {
        ...(refMeta.fill !== undefined ? { fill: refMeta.fill } : {}),
        ...(refMeta.align !== undefined ? { align: refMeta.align } : {}),
        ...(refMeta.verticalAlign !== undefined ? { verticalAlign: refMeta.verticalAlign } : {}),
        ...(refMeta.overflow !== undefined ? { overflow: refMeta.overflow } : {}),
        ...(refMeta.borders !== undefined ? { borders: { ...refMeta.borders } } : {})
      };
      if (Object.keys(inheritedCellMeta).length > 0) {
        for (let c = safeIndex; c < safeIndex + safeCount; c++) {
          nextCellMeta[cellKey(r, c)] = { ...inheritedCellMeta };
        }
      }
    }
  }

  // 3. 迁移 TextBlocks (继承相邻列对应行的字体排版样式)
  const nextBlocks: TextBlock[] = [];
  const existingMap = new Map<string, TextBlock>();
  for (const block of node.textBlocks ?? []) {
    if (block.slot) existingMap.set(block.slot, block);
  }

  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount + safeCount; c++) {
      const currentSlot = tableCellSlot(r, c);
      if (c >= safeIndex && c < safeIndex + safeCount) {
        const refBlock = existingMap.get(tableCellSlot(r, refCol));
        nextBlocks.push({
          id: currentSlot,
          slot: currentSlot,
          runs: [{ text: '' }],
          ...(refBlock?.style ? { style: { ...refBlock.style } } : {})
        });
      } else {
        const oldCol = c >= safeIndex + safeCount ? c - safeCount : c;
        const oldSlot = tableCellSlot(r, oldCol);
        const oldBlock = existingMap.get(oldSlot);
        nextBlocks.push({
          ...(oldBlock ?? { runs: [{ text: '' }] }),
          id: currentSlot,
          slot: currentSlot
        });
      }
    }
  }

  // 4. 迁移合并单元格
  const nextMerges: TableMergeRange[] = [];
  for (const merge of table.merges ?? []) {
    if (merge.startCol >= safeIndex) {
      nextMerges.push({
        ...merge,
        startCol: merge.startCol + safeCount,
        endCol: merge.endCol + safeCount
      });
    } else if (merge.endCol >= safeIndex) {
      nextMerges.push({
        ...merge,
        endCol: merge.endCol + safeCount
      });
    } else {
      nextMerges.push(merge);
    }
  }

  const nextTable: TableNodeFields = {
    ...table,
    columnCount: colCount + safeCount,
    columns: nextCols,
    cellMeta: nextCellMeta,
    merges: nextMerges.length > 0 ? nextMerges : undefined
  };

  const tracks = computeTableTracks(nextTable.rowCount, nextTable.columnCount, nextTable.rows, nextTable.columns);
  const updatedNode: NodeEntity = {
    ...node,
    width: tracks.totalWidth,
    table: nextTable,
    textBlocks: nextBlocks
  };

  return { updatedNode, patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode } };
}

/** 删除单列或多列 (表格必须至少保留一列) */
export function removeColumnsOperation(
  node: Readonly<NodeEntity>,
  atIndex: number,
  count = 1
): { updatedNode: NodeEntity; patch: CanvasPatch } | null {
  const table = getTableFields(node);
  const rowCount = table.rowCount;
  const colCount = table.columnCount;
  if (count <= 0 || count >= colCount || colCount <= 1) return null;
  const safeCount = count;
  const safeIndex = Math.max(0, Math.min(atIndex, colCount - safeCount));
  const endIndex = safeIndex + safeCount;

  // 1. 迁移 columns 稀疏元数据
  const nextCols: TableColumnMeta[] = [];
  for (let c = 0; c < colCount; c++) {
    if (c >= safeIndex && c < endIndex) continue;
    nextCols.push(table.columns?.[c] ?? {});
  }

  // 2. 迁移 cellMeta
  const nextCellMeta: Record<string, TableCellMeta> = {};
  if (table.cellMeta) {
    for (const [key, meta] of Object.entries(table.cellMeta)) {
      const pos = parseCellKey(key);
      if (!pos || (pos.col >= safeIndex && pos.col < endIndex)) continue;
      const c = pos.col >= endIndex ? pos.col - safeCount : pos.col;
      nextCellMeta[cellKey(pos.row, c)] = meta;
    }
  }

  // 3. 迁移 TextBlocks
  const nextBlocks: TextBlock[] = [];
  const existingMap = new Map<string, TextBlock>();
  for (const block of node.textBlocks ?? []) {
    if (block.slot) existingMap.set(block.slot, block);
  }

  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount - safeCount; c++) {
      const currentSlot = tableCellSlot(r, c);
      const oldCol = c >= safeIndex ? c + safeCount : c;
      const oldSlot = tableCellSlot(r, oldCol);
      const oldBlock = existingMap.get(oldSlot);
      nextBlocks.push({
        ...(oldBlock ?? { runs: [{ text: '' }] }),
        id: currentSlot,
        slot: currentSlot
      });
    }
  }

  // 4. 迁移合并单元格
  const nextMerges: TableMergeRange[] = [];
  for (const merge of table.merges ?? []) {
    if (merge.startCol >= safeIndex && merge.endCol < endIndex) continue;

    let startCol = merge.startCol;
    let endCol = merge.endCol;

    if (startCol >= endIndex) {
      startCol -= safeCount;
      endCol -= safeCount;
    } else if (startCol >= safeIndex && startCol < endIndex) {
      startCol = safeIndex;
      endCol -= safeCount;
    } else if (endCol >= safeIndex) {
      endCol = Math.max(startCol, endCol - safeCount);
    }

    if (merge.startRow === merge.endRow && startCol === endCol) continue;
    nextMerges.push({ ...merge, startCol, endCol });
  }

  const nextTable: TableNodeFields = {
    ...table,
    columnCount: colCount - safeCount,
    columns: nextCols,
    cellMeta: nextCellMeta,
    merges: nextMerges.length > 0 ? nextMerges : undefined
  };

  const tracks = computeTableTracks(nextTable.rowCount, nextTable.columnCount, nextTable.rows, nextTable.columns);
  const updatedNode: NodeEntity = {
    ...node,
    width: tracks.totalWidth,
    table: nextTable,
    textBlocks: nextBlocks
  };

  return { updatedNode, patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode } };
}

/** 调整特定行高 */
export function resizeRowOperation(
  node: Readonly<NodeEntity>,
  rowIndex: number,
  newHeight: number
): { updatedNode: NodeEntity; patch: CanvasPatch } | null {
  const table = getTableFields(node);
  if (rowIndex < 0 || rowIndex >= table.rowCount) return null;
  const clampedH = Math.max(MIN_ROW_HEIGHT, Math.round(newHeight));

  const nextRows = Array.from({ length: table.rowCount }, (_, r) => {
    if (r === rowIndex) return { height: clampedH, minHeight: clampedH };
    return table.rows?.[r] ?? {};
  });

  const nextTable: TableNodeFields = {
    ...table,
    rows: nextRows
  };

  const tracks = computeTableTracks(nextTable.rowCount, nextTable.columnCount, nextTable.rows, nextTable.columns);
  const updatedNode: NodeEntity = {
    ...node,
    height: tracks.totalHeight,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 调整特定列宽 */
export function resizeColumnOperation(
  node: Readonly<NodeEntity>,
  colIndex: number,
  newWidth: number
): { updatedNode: NodeEntity; patch: CanvasPatch } | null {
  const table = getTableFields(node);
  if (colIndex < 0 || colIndex >= table.columnCount) return null;
  const clampedW = Math.max(MIN_COLUMN_WIDTH, Math.round(newWidth));

  const nextCols = Array.from({ length: table.columnCount }, (_, c) => {
    if (c === colIndex) return { width: clampedW };
    return table.columns?.[c] ?? {};
  });

  const nextTable: TableNodeFields = {
    ...table,
    columns: nextCols
  };

  const tracks = computeTableTracks(nextTable.rowCount, nextTable.columnCount, nextTable.rows, nextTable.columns);
  const updatedNode: NodeEntity = {
    ...node,
    width: tracks.totalWidth,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 合并指定矩形范围内的单元格 */
export function mergeCellsOperation(
  node: Readonly<NodeEntity>,
  range: TableMergeRange
): { updatedNode: NodeEntity; patch: CanvasPatch } | null {
  const table = getTableFields(node);
  const startRow = Math.max(0, Math.min(range.startRow, range.endRow));
  const endRow = Math.min(table.rowCount - 1, Math.max(range.startRow, range.endRow));
  const startCol = Math.max(0, Math.min(range.startCol, range.endCol));
  const endCol = Math.min(table.columnCount - 1, Math.max(range.startCol, range.endCol));

  if (startRow > endRow || startCol > endCol || (startRow === endRow && startCol === endCol)) return null;
  const newRange: TableMergeRange = { startRow, startCol, endRow, endCol };

  // 仅替换被完整纳入的新旧合并块，避免修改选区外的合并关系。
  if (
    table.merges?.some((merge) => {
      const intersects =
        merge.startRow <= endRow && merge.endRow >= startRow && merge.startCol <= endCol && merge.endCol >= startCol;
      return (
        intersects &&
        (merge.startRow < startRow || merge.endRow > endRow || merge.startCol < startCol || merge.endCol > endCol)
      );
    })
  )
    return null;
  const filtered = (table.merges ?? []).filter((m) => {
    const intersect = !(m.endRow < startRow || m.startRow > endRow || m.endCol < startCol || m.startCol > endCol);
    return !intersect;
  });

  const nextMerges = [...filtered, newRange];
  const nextTable: TableNodeFields = {
    ...table,
    merges: nextMerges
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 取消合并指定矩形范围内的合并单元格 */
export function unmergeCellsOperation(
  node: Readonly<NodeEntity>,
  row: number,
  col: number,
  endRow = row,
  endCol = col
): { updatedNode: NodeEntity; patch: CanvasPatch } | null {
  const table = getTableFields(node);
  if (!table.merges || table.merges.length === 0) return null;

  const nextMerges = table.merges.filter((m) => {
    return m.startRow > endRow || m.endRow < row || m.startCol > endCol || m.endCol < col;
  });

  if (nextMerges.length === table.merges.length) return null;

  const nextTable: TableNodeFields = {
    ...table,
    merges: nextMerges.length > 0 ? nextMerges : undefined
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 为指定矩形范围内的单元格设置底色 (纯函数事务生成) */
export function setCellFillOperation(
  node: Readonly<NodeEntity>,
  range: TableMergeRange,
  fill: string | undefined
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const minR = Math.max(0, Math.min(range.startRow, range.endRow));
  const maxR = Math.min(table.rowCount - 1, Math.max(range.startRow, range.endRow));
  const minC = Math.max(0, Math.min(range.startCol, range.endCol));
  const maxC = Math.min(table.columnCount - 1, Math.max(range.startCol, range.endCol));

  const nextCellMeta: Record<string, TableCellMeta> = { ...(table.cellMeta ?? {}) };
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const key = cellKey(r, c);
      const prev = nextCellMeta[key] ?? {};
      if (fill === undefined) {
        const { fill: _f, ...rest } = prev;
        if (Object.keys(rest).length > 0) {
          nextCellMeta[key] = rest;
        } else {
          delete nextCellMeta[key];
        }
      } else {
        nextCellMeta[key] = { ...prev, fill };
      }
    }
  }

  const nextTable: TableNodeFields = {
    ...table,
    cellMeta: nextCellMeta
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 为指定矩形范围内的单元格设置/覆盖边框样式 (纯函数事务生成) */
export function setCellBordersOperation(
  node: Readonly<NodeEntity>,
  range: TableMergeRange,
  borders: TableCellBorders
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const minR = Math.max(0, Math.min(range.startRow, range.endRow));
  const maxR = Math.min(table.rowCount - 1, Math.max(range.startRow, range.endRow));
  const minC = Math.max(0, Math.min(range.startCol, range.endCol));
  const maxC = Math.min(table.columnCount - 1, Math.max(range.startCol, range.endCol));

  const nextCellMeta: Record<string, TableCellMeta> = { ...(table.cellMeta ?? {}) };

  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const key = cellKey(r, c);
      const prevMeta = nextCellMeta[key] ?? {};
      const prevBorders = prevMeta.borders ?? {};
      nextCellMeta[key] = {
        ...prevMeta,
        borders: {
          ...prevBorders,
          ...(borders.top !== undefined ? { top: borders.top } : {}),
          ...(borders.right !== undefined ? { right: borders.right } : {}),
          ...(borders.bottom !== undefined ? { bottom: borders.bottom } : {}),
          ...(borders.left !== undefined ? { left: borders.left } : {})
        }
      };
    }
  }

  const nextTable: TableNodeFields = {
    ...table,
    cellMeta: nextCellMeta
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 清除指定矩形范围内单元格的自定义边框 */
export function clearCellBordersOperation(
  node: Readonly<NodeEntity>,
  range: TableMergeRange
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const minR = Math.max(0, Math.min(range.startRow, range.endRow));
  const maxR = Math.min(table.rowCount - 1, Math.max(range.startRow, range.endRow));
  const minC = Math.max(0, Math.min(range.startCol, range.endCol));
  const maxC = Math.min(table.columnCount - 1, Math.max(range.startCol, range.endCol));
  const isFullTable = minR === 0 && maxR === table.rowCount - 1 && minC === 0 && maxC === table.columnCount - 1;

  if (!table.cellMeta) {
    const updatedNode: NodeEntity = {
      ...node,
      table: {
        ...table,
        ...(isFullTable ? { innerBorder: undefined, innerBorders: undefined } : {}),
        cellMeta: {}
      }
    };
    return {
      updatedNode,
      patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
    };
  }

  const nextCellMeta: Record<string, TableCellMeta> = { ...table.cellMeta };

  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const key = cellKey(r, c);
      if (nextCellMeta[key]?.borders) {
        const { borders: _, ...rest } = nextCellMeta[key];
        nextCellMeta[key] = rest;
      }
    }
  }

  const nextTable: TableNodeFields = {
    ...table,
    ...(isFullTable ? { innerBorder: undefined, innerBorders: undefined } : {}),
    cellMeta: nextCellMeta
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 设置表格外边框样式 (通过节点原生 style 属性) */
export function setOuterBorderOperation(
  node: Readonly<NodeEntity>,
  border: TableBorderSide
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const nextStyle = {
    ...node.style,
    stroke: border.color !== undefined ? border.color : node.style?.stroke,
    strokeWidth: border.width !== undefined ? border.width : (node.style?.strokeWidth ?? 1),
    strokeDashArray:
      border.style === 'dashed'
        ? [4, 4]
        : border.style === 'dotted'
          ? [2, 2]
          : border.style === 'solid'
            ? undefined
            : node.style?.strokeDashArray
  };

  const updatedNode: NodeEntity = {
    ...node,
    style: nextStyle
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 配色切换保留全部框线覆盖。 */
export function setTableThemeOperation(
  node: Readonly<NodeEntity>,
  themeId: string
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const updatedNode = { ...node, table: { ...getTableFields(node), themeId } };
  return { updatedNode, patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode } };
}

/** 应用整表框线预设，清除分边覆盖，保留配色与其他单元格格式。 */
export function setTableGridStyleOperation(
  node: Readonly<NodeEntity>,
  gridStyle: TableGridStyle
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const cellMeta =
    table.cellMeta &&
    Object.fromEntries(
      Object.entries(table.cellMeta).map(([key, meta]) => {
        const { borders: _borders, ...rest } = meta;
        return [key, rest];
      })
    );
  const style = { ...node.style };
  delete style.strokeWidth;
  delete style.strokeDashArray;
  const updatedNode = {
    ...node,
    style,
    table: {
      ...table,
      gridStyle,
      outerBorder: undefined,
      outerBorders: undefined,
      innerBorder: undefined,
      innerBorders: undefined,
      cellMeta
    }
  };
  return { updatedNode, patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode } };
}

/** 切换隔行斑马纹 */
export function toggleBandedRowsOperation(
  node: Readonly<NodeEntity>,
  enabled?: boolean
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const theme = tableThemeRegistry.getTheme(table.themeId);
  const currentVal = table.bandedRows ?? theme.defaultBandedRows ?? false;
  const nextVal = enabled !== undefined ? enabled : !currentVal;
  const nextTable: TableNodeFields = {
    ...table,
    bandedRows: nextVal
  };
  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };
  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 切换汇总行高亮 */
export function toggleTotalRowOperation(
  node: Readonly<NodeEntity>,
  enabled?: boolean
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const theme = tableThemeRegistry.getTheme(table.themeId);
  const currentVal = table.totalRow ?? theme.defaultTotalRow ?? false;
  const nextVal = enabled !== undefined ? enabled : !currentVal;
  const nextTable: TableNodeFields = {
    ...table,
    totalRow: nextVal
  };
  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };
  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 切换表格外侧框线 (Word 同款外边框开关) */
export function toggleOuterBorderOperation(
  node: Readonly<NodeEntity>,
  enabled?: boolean
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const currentVal = table.outerBorder ?? getTableGridStyle(table.gridStyle).defaultOuterBorder;
  const nextVal = enabled !== undefined ? enabled : !currentVal;

  let nextCellMeta = table.cellMeta;
  if (!nextVal && nextCellMeta) {
    // 关闭外边框时，同时清除外围四周边缘记录的自定义外框线，防止关闭后依然残留
    const rowCount = table.rowCount;
    const colCount = table.columnCount;
    let metaChanged = false;
    const cleanedMeta: Record<string, TableCellMeta> = { ...nextCellMeta };
    for (let c = 0; c < colCount; c++) {
      const topKey = cellKey(0, c);
      if (cleanedMeta[topKey]?.borders?.top) {
        const { top: _t, ...restBorders } = cleanedMeta[topKey].borders!;
        cleanedMeta[topKey] = {
          ...cleanedMeta[topKey],
          borders: Object.keys(restBorders).length > 0 ? restBorders : undefined
        };
        metaChanged = true;
      }
      const botKey = cellKey(rowCount - 1, c);
      if (cleanedMeta[botKey]?.borders?.bottom) {
        const { bottom: _b, ...restBorders } = cleanedMeta[botKey].borders!;
        cleanedMeta[botKey] = {
          ...cleanedMeta[botKey],
          borders: Object.keys(restBorders).length > 0 ? restBorders : undefined
        };
        metaChanged = true;
      }
    }
    for (let r = 0; r < rowCount; r++) {
      const leftKey = cellKey(r, 0);
      if (cleanedMeta[leftKey]?.borders?.left) {
        const { left: _l, ...restBorders } = cleanedMeta[leftKey].borders!;
        cleanedMeta[leftKey] = {
          ...cleanedMeta[leftKey],
          borders: Object.keys(restBorders).length > 0 ? restBorders : undefined
        };
        metaChanged = true;
      }
      const rightKey = cellKey(r, colCount - 1);
      if (cleanedMeta[rightKey]?.borders?.right) {
        const { right: _r, ...restBorders } = cleanedMeta[rightKey].borders!;
        cleanedMeta[rightKey] = {
          ...cleanedMeta[rightKey],
          borders: Object.keys(restBorders).length > 0 ? restBorders : undefined
        };
        metaChanged = true;
      }
    }
    if (metaChanged) {
      nextCellMeta = cleanedMeta;
    }
  }

  const defaults = getTableGridStyle(table.gridStyle).defaultOuterSides;
  const outerBorders =
    nextVal &&
    table.outerBorders &&
    ['top', 'bottom', 'left', 'right'].every((side) => table.outerBorders![side as keyof TableOuterSides] === false)
      ? {
          ...table.outerBorders,
          top: defaults?.top ?? true,
          bottom: defaults?.bottom ?? true,
          left: defaults?.left ?? true,
          right: defaults?.right ?? true
        }
      : table.outerBorders;
  const sideStyles =
    outerBorders?.sideStyles &&
    Object.fromEntries(
      Object.entries(outerBorders.sideStyles).map(([side, value]) => [
        side,
        { ...value, visible: nextVal && (defaults?.[side as keyof TableOuterSides] ?? true) }
      ])
    );
  const nextTable: TableNodeFields = {
    ...table,
    outerBorder: nextVal,
    outerBorders: outerBorders ? { ...outerBorders, sideStyles } : undefined,
    cellMeta: nextCellMeta
  };
  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };
  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 设置表格级独立外边框四向显隐与统一线型/粗细/颜色 (独立存储于 table.outerBorders，不污染单元格局部 cellMeta) */
export function setOuterBordersOperation(
  node: Readonly<NodeEntity>,
  sides: TableOuterSides,
  border?: TableBorderSide
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const { rowCount, columnCount } = table;
  let nextCellMeta = table.cellMeta;

  // 清理外围单元格上可能残留的旧四边覆盖项，使表格级 outerBorders 立即在最外圈生效
  if (nextCellMeta) {
    let metaChanged = false;
    const cleanedMeta: Record<string, TableCellMeta> = { ...nextCellMeta };
    for (let c = 0; c < columnCount; c++) {
      const topKey = cellKey(0, c);
      if (sides.top !== undefined && cleanedMeta[topKey]?.borders?.top !== undefined) {
        const { top: _t, ...rest } = cleanedMeta[topKey].borders!;
        cleanedMeta[topKey] = {
          ...cleanedMeta[topKey],
          borders: Object.keys(rest).length > 0 ? rest : undefined
        };
        metaChanged = true;
      }
      const botKey = cellKey(rowCount - 1, c);
      if (sides.bottom !== undefined && cleanedMeta[botKey]?.borders?.bottom !== undefined) {
        const { bottom: _b, ...rest } = cleanedMeta[botKey].borders!;
        cleanedMeta[botKey] = {
          ...cleanedMeta[botKey],
          borders: Object.keys(rest).length > 0 ? rest : undefined
        };
        metaChanged = true;
      }
    }
    for (let r = 0; r < rowCount; r++) {
      const leftKey = cellKey(r, 0);
      if (sides.left !== undefined && cleanedMeta[leftKey]?.borders?.left !== undefined) {
        const { left: _l, ...rest } = cleanedMeta[leftKey].borders!;
        cleanedMeta[leftKey] = {
          ...cleanedMeta[leftKey],
          borders: Object.keys(rest).length > 0 ? rest : undefined
        };
        metaChanged = true;
      }
      const rightKey = cellKey(r, columnCount - 1);
      if (sides.right !== undefined && cleanedMeta[rightKey]?.borders?.right !== undefined) {
        const { right: _r, ...rest } = cleanedMeta[rightKey].borders!;
        cleanedMeta[rightKey] = {
          ...cleanedMeta[rightKey],
          borders: Object.keys(rest).length > 0 ? rest : undefined
        };
        metaChanged = true;
      }
    }
    if (metaChanged) {
      nextCellMeta = cleanedMeta;
    }
  }

  const prevOuter = table.outerBorders;
  const grid = getTableGridStyle(table.gridStyle);
  const defaults = grid.defaultOuterSides;
  const safeWidth =
    typeof border?.width === 'number' && border.width > 0
      ? border.width
      : (prevOuter?.width ?? grid.outerBorder?.width ?? grid.strokeWidth ?? 1);
  const nextColor = border ? border.color || undefined : prevOuter?.color;
  const nextOuterBorders: TableOuterBorderConfig = {
    sideStyles: undefined,
    top: sides.top ?? prevOuter?.top ?? defaults?.top ?? true,
    bottom: sides.bottom ?? prevOuter?.bottom ?? defaults?.bottom ?? true,
    left: sides.left ?? prevOuter?.left ?? defaults?.left ?? true,
    right: sides.right ?? prevOuter?.right ?? defaults?.right ?? true,
    width: safeWidth,
    style: border?.style ?? prevOuter?.style ?? 'solid',
    ...(nextColor ? { color: nextColor } : {})
  };

  const nextTable: TableNodeFields = {
    ...table,
    outerBorder: Boolean(
      nextOuterBorders.top || nextOuterBorders.bottom || nextOuterBorders.left || nextOuterBorders.right
    ),
    outerBorders: nextOuterBorders,
    cellMeta: nextCellMeta
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 切换表格级内部框线总开关 */
export function toggleInnerBorderOperation(
  node: Readonly<NodeEntity>,
  enabled?: boolean
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const grid = getTableGridStyle(table.gridStyle);
  const defaultVal = grid.id === 'grid' || grid.id === 'three-line' || grid.id === 'horizontal';
  const currentVal = table.innerBorder ?? defaultVal;
  const nextVal = enabled !== undefined ? enabled : !currentVal;

  return setInnerBordersOperation(
    node,
    { horizontal: nextVal, vertical: nextVal },
    table.innerBorders
      ? {
          width: table.innerBorders.width ?? grid.strokeWidth ?? 1,
          style: table.innerBorders.style ?? 'solid',
          color: table.innerBorders.color
        }
      : undefined
  );
}

/** 设置表格级独立内边框横竖显隐与统一线型/粗细/颜色 (独立存储于 table.innerBorders，新增行列自动适用) */
export function setInnerBordersOperation(
  node: Readonly<NodeEntity>,
  sides: { horizontal?: boolean; vertical?: boolean },
  border?: TableBorderSide
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const { rowCount, columnCount } = table;
  let nextCellMeta = table.cellMeta;

  // 清理内部共享边上的单元格级边框覆盖项，使表格级 innerBorders 在全表统一生效
  if (nextCellMeta) {
    let metaChanged = false;
    const cleanedMeta: Record<string, TableCellMeta> = { ...nextCellMeta };
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < columnCount; c++) {
        const key = cellKey(r, c);
        const b = cleanedMeta[key]?.borders;
        if (!b) continue;
        const nextB = { ...b };
        if (sides.horizontal !== undefined) {
          if (r > 0 && nextB.top !== undefined) {
            delete nextB.top;
            metaChanged = true;
          }
          if (r < rowCount - 1 && nextB.bottom !== undefined) {
            delete nextB.bottom;
            metaChanged = true;
          }
        }
        if (sides.vertical !== undefined) {
          if (c > 0 && nextB.left !== undefined) {
            delete nextB.left;
            metaChanged = true;
          }
          if (c < columnCount - 1 && nextB.right !== undefined) {
            delete nextB.right;
            metaChanged = true;
          }
        }
        cleanedMeta[key] = {
          ...cleanedMeta[key],
          borders: Object.keys(nextB).length > 0 ? nextB : undefined
        };
      }
    }
    if (metaChanged) {
      nextCellMeta = cleanedMeta;
    }
  }

  const prevInner = table.innerBorders;
  const grid = getTableGridStyle(table.gridStyle);
  const defaultH = grid.id === 'grid' || grid.id === 'three-line' || grid.id === 'horizontal';
  const defaultV = grid.id === 'grid';
  const horizontal = sides.horizontal ?? prevInner?.horizontal ?? defaultH;
  const vertical = sides.vertical ?? prevInner?.vertical ?? defaultV;
  const safeWidth = typeof border?.width === 'number' && border.width > 0 ? border.width : (prevInner?.width ?? 1);
  const nextColor = border ? border.color || undefined : prevInner?.color;

  const nextInnerBorders: TableInnerBorderConfig = {
    sideStyles: undefined,
    horizontal,
    vertical,
    width: safeWidth,
    style: border?.style ?? prevInner?.style ?? 'solid',
    ...(nextColor ? { color: nextColor } : {})
  };

  const nextTable: TableNodeFields = {
    ...table,
    innerBorder: horizontal || vertical,
    innerBorders: nextInnerBorders,
    cellMeta: nextCellMeta
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 清除表格用户手动格式，完全恢复当前主题默认外观 (Word 同款清除表格格式) */
export function clearTableFormattingOperation(node: Readonly<NodeEntity>): {
  updatedNode: NodeEntity;
  patch: CanvasPatch;
} {
  const table = getTableFields(node);
  const theme = tableThemeRegistry.getTheme(table.themeId);
  const isHeaderRow = theme.defaultHeaderRow ?? true;

  const nextTable: TableNodeFields = {
    ...table,
    headerRow: undefined,
    headerColumn: undefined,
    bandedRows: undefined,
    bandedColumns: undefined,
    totalRow: undefined,
    outerBorder: undefined,
    outerBorders: undefined,
    innerBorder: undefined,
    innerBorders: undefined,
    cellOverflow: undefined,
    cellMeta: undefined
  };
  const nextStyle = { ...node.style };
  delete nextStyle.stroke;
  delete nextStyle.strokeWidth;
  delete nextStyle.strokeOpacity;
  delete nextStyle.strokeDashArray;
  delete nextStyle.fill;
  delete nextStyle.fillOpacity;

  const nextBlocks: TextBlock[] | undefined = node.textBlocks?.map((block) => {
    const pos = block.slot ? parseTableCellSlot(block.slot) : null;
    const isHeader = Boolean(pos && pos.row === 0 && isHeaderRow);
    const plainText = block.runs.map((r) => r.text).join('');
    return {
      id: block.id,
      slot: block.slot,
      runs: [{ text: plainText }],
      style: {
        fontSize: 13,
        fontWeight: isHeader ? 600 : 400,
        textAlign: isHeader ? (theme.headerAlign ?? 'center') : (theme.bodyAlign ?? 'left'),
        verticalAlign: isHeader ? (theme.headerVerticalAlign ?? 'middle') : (theme.bodyVerticalAlign ?? 'middle')
      }
    };
  });

  const updatedNode: NodeEntity = {
    ...node,
    style: nextStyle,
    textStyle: undefined,
    table: nextTable,
    ...(nextBlocks ? { textBlocks: nextBlocks } : {})
  };
  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 清除指定矩形范围内单元格的自定义格式 (底色、边框、对齐、溢出策略、斜线与文字内联样式) */
export function clearCellsFormattingOperation(
  node: Readonly<NodeEntity>,
  range: TableMergeRange
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const theme = tableThemeRegistry.getTheme(table.themeId);
  const isHeaderRow = table.headerRow ?? theme.defaultHeaderRow ?? true;
  const minR = Math.max(0, Math.min(range.startRow, range.endRow));
  const maxR = Math.min(table.rowCount - 1, Math.max(range.startRow, range.endRow));
  const minC = Math.max(0, Math.min(range.startCol, range.endCol));
  const maxC = Math.min(table.columnCount - 1, Math.max(range.startCol, range.endCol));

  const nextCellMeta: Record<string, TableCellMeta> = { ...(table.cellMeta ?? {}) };
  const targetSlots = new Set<string>();

  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      delete nextCellMeta[cellKey(r, c)];
      targetSlots.add(tableCellSlot(r, c));
    }
  }

  const nextBlocks: TextBlock[] | undefined = node.textBlocks?.map((block) => {
    if (!block.slot || !targetSlots.has(block.slot)) return block;
    const pos = parseTableCellSlot(block.slot);
    const isHeader = Boolean(pos && pos.row === 0 && isHeaderRow);
    const plainText = block.runs.map((r) => r.text).join('');
    return {
      id: block.id,
      slot: block.slot,
      runs: [{ text: plainText }],
      style: {
        fontSize: 13,
        fontWeight: isHeader ? 600 : 400,
        textAlign: isHeader ? (theme.headerAlign ?? 'center') : (theme.bodyAlign ?? 'left'),
        verticalAlign: isHeader ? (theme.headerVerticalAlign ?? 'middle') : (theme.bodyVerticalAlign ?? 'middle')
      }
    };
  });

  const nextTable: TableNodeFields = {
    ...table,
    cellMeta: Object.keys(nextCellMeta).length > 0 ? nextCellMeta : undefined
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable,
    ...(nextBlocks ? { textBlocks: nextBlocks } : {})
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 重排一条轴，保留行列尺寸、文字和单元格样式；会割裂合并范围时拒绝。 */
export function reorderTableTracks(
  node: Readonly<NodeEntity>,
  axis: 'row' | 'column',
  order: readonly number[]
): NodeEntity | null {
  const table = getTableFields(node);
  const count = axis === 'row' ? table.rowCount : table.columnCount;
  if (order.length !== count || order.every((value, index) => value === index)) return null;
  const positions = new Map(order.map((previous, index) => [previous, index]));
  if (positions.size !== count || order.some((value) => !Number.isInteger(value) || value < 0 || value >= count))
    return null;
  const coordinate = (row: number, col: number): [number, number] =>
    axis === 'row' ? [positions.get(row)!, col] : [row, positions.get(col)!];
  const merges: TableMergeRange[] = [];
  for (const merge of table.merges ?? []) {
    const start = axis === 'row' ? merge.startRow : merge.startCol;
    const end = axis === 'row' ? merge.endRow : merge.endCol;
    const offset = positions.get(start)! - start;
    for (let i = start; i <= end; i++) {
      if (positions.get(i) !== i + offset) return null;
    }
    const [startRow, startCol] = coordinate(merge.startRow, merge.startCol);
    const [endRow, endCol] = coordinate(merge.endRow, merge.endCol);
    merges.push({ startRow, startCol, endRow, endCol });
  }
  const cellMeta: Record<string, TableCellMeta> = {};
  for (const [key, meta] of Object.entries(table.cellMeta ?? {})) {
    const pos = parseCellKey(key);
    if (pos) cellMeta[cellKey(...coordinate(pos.row, pos.col))] = meta;
  }
  const textBlocks = node.textBlocks?.map((block) => {
    const pos = block.slot && parseTableCellSlot(block.slot);
    if (!pos) return block;
    const slot = tableCellSlot(...coordinate(pos.row, pos.col));
    return { ...block, id: slot, slot };
  });
  return {
    ...node,
    textBlocks,
    table: {
      ...table,
      rows: axis === 'row' && table.rows ? order.map((i) => table.rows?.[i] ?? {}) : table.rows,
      columns: axis === 'column' && table.columns ? order.map((i) => table.columns?.[i] ?? {}) : table.columns,
      merges: table.merges ? merges : undefined,
      cellMeta: table.cellMeta ? cellMeta : undefined
    }
  };
}

/** 平均分布各列宽度 (Word 同款) */
export function distributeColumnsOperation(
  node: Readonly<NodeEntity>,
  startCol?: number,
  endCol?: number
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const colCount = table.columnCount;
  const minC = Math.max(0, Math.min(startCol ?? 0, colCount - 1));
  const maxC = Math.max(minC, Math.min(endCol ?? colCount - 1, colCount - 1));
  const span = maxC - minC + 1;

  const tracks = computeTableTracks(table.rowCount, table.columnCount, table.rows, table.columns);
  let totalSpanWidth = 0;
  for (let c = minC; c <= maxC; c++) {
    totalSpanWidth += tracks.colStarts[c + 1] - tracks.colStarts[c];
  }
  const avgWidth = Math.max(MIN_COLUMN_WIDTH, Math.floor(totalSpanWidth / span));

  const nextCols: TableColumnMeta[] = Array.from({ length: colCount }, (_, c) => {
    if (c >= minC && c <= maxC) {
      return { width: avgWidth };
    }
    return table.columns?.[c] ?? {};
  });

  const nextTracks = computeTableTracks(table.rowCount, table.columnCount, table.rows, nextCols);
  const nextTable: TableNodeFields = {
    ...table,
    columns: nextCols
  };
  const updatedNode: NodeEntity = {
    ...node,
    width: nextTracks.totalWidth,
    height: nextTracks.totalHeight,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 平均分布各行高度 (Word 同款) */
export function distributeRowsOperation(
  node: Readonly<NodeEntity>,
  startRow?: number,
  endRow?: number
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const rowCount = table.rowCount;
  const minR = Math.max(0, Math.min(startRow ?? 0, rowCount - 1));
  const maxR = Math.max(minR, Math.min(endRow ?? rowCount - 1, rowCount - 1));
  const span = maxR - minR + 1;

  const tracks = computeTableTracks(table.rowCount, table.columnCount, table.rows, table.columns);
  let totalSpanHeight = 0;
  for (let r = minR; r <= maxR; r++) {
    totalSpanHeight += tracks.rowStarts[r + 1] - tracks.rowStarts[r];
  }
  const avgHeight = Math.max(MIN_ROW_HEIGHT, Math.floor(totalSpanHeight / span));

  const nextRows: TableRowMeta[] = Array.from({ length: rowCount }, (_, r) => {
    if (r >= minR && r <= maxR) {
      return { height: avgHeight, minHeight: avgHeight };
    }
    return table.rows?.[r] ?? {};
  });

  const nextTracks = computeTableTracks(table.rowCount, table.columnCount, nextRows, table.columns);
  const nextTable: TableNodeFields = {
    ...table,
    rows: nextRows
  };
  const updatedNode: NodeEntity = {
    ...node,
    width: nextTracks.totalWidth,
    height: nextTracks.totalHeight,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 设置单元格九宫格对齐方式 (水平对齐与垂直对齐) */
export function setCellAlignmentOperation(
  node: Readonly<NodeEntity>,
  range: TableMergeRange,
  align?: 'left' | 'center' | 'right',
  verticalAlign?: 'top' | 'middle' | 'bottom'
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const minR = Math.max(0, Math.min(range.startRow, range.endRow));
  const maxR = Math.min(table.rowCount - 1, Math.max(range.startRow, range.endRow));
  const minC = Math.max(0, Math.min(range.startCol, range.endCol));
  const maxC = Math.min(table.columnCount - 1, Math.max(range.startCol, range.endCol));

  const nextCellMeta: Record<string, TableCellMeta> = { ...(table.cellMeta ?? {}) };
  const targetSlots = new Set<string>();

  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const key = cellKey(r, c);
      const prev = nextCellMeta[key] ?? {};
      nextCellMeta[key] = {
        ...prev,
        ...(align !== undefined ? { align } : {}),
        ...(verticalAlign !== undefined ? { verticalAlign } : {})
      };
      targetSlots.add(tableCellSlot(r, c));
    }
  }

  // 同步更新 textBlocks 中的样式与段落级对齐
  const nextBlocks = (node.textBlocks ?? []).map((block) => {
    if (!block.slot || !targetSlots.has(block.slot)) return block;
    return {
      ...block,
      runs: align !== undefined ? block.runs.map((run) => ({ ...run, textAlign: align })) : block.runs,
      style: {
        ...block.style,
        ...(align !== undefined ? { textAlign: align } : {}),
        ...(verticalAlign !== undefined ? { verticalAlign } : {})
      }
    };
  });

  const nextTable: TableNodeFields = {
    ...table,
    cellMeta: nextCellMeta
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable,
    textBlocks: nextBlocks
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 设置单元格文字溢出策略 (自动撑高 auto-height / 溢出省略 ellipsis) */
export function setCellOverflowOperation(
  node: Readonly<NodeEntity>,
  range: TableMergeRange,
  overflow: TableCellOverflowMode
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const minR = Math.max(0, Math.min(range.startRow, range.endRow));
  const maxR = Math.min(table.rowCount - 1, Math.max(range.startRow, range.endRow));
  const minC = Math.max(0, Math.min(range.startCol, range.endCol));
  const maxC = Math.min(table.columnCount - 1, Math.max(range.startCol, range.endCol));
  const isFullTable = minR === 0 && maxR === table.rowCount - 1 && minC === 0 && maxC === table.columnCount - 1;

  const nextCellMeta: Record<string, TableCellMeta> = { ...(table.cellMeta ?? {}) };
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      const key = cellKey(r, c);
      const prev = nextCellMeta[key] ?? {};
      nextCellMeta[key] = { ...prev, overflow };
    }
  }

  const nextTable: TableNodeFields = {
    ...table,
    ...(isFullTable ? { cellOverflow: overflow } : {}),
    cellMeta: nextCellMeta
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 切换斜线表头 (无 -> 左上到右下 down -> 左下到右上 up -> 无)，若原先配置过颜色/样式则予以保留 */
export function toggleCellDiagonalOperation(
  node: Readonly<NodeEntity>,
  row: number,
  col: number,
  diagonal?: TableCellDiagonalDirection | null
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const key = cellKey(row, col);
  const prevMeta = table.cellMeta?.[key] ?? {};
  const prevDiag = prevMeta.diagonal;
  const prevDir = typeof prevDiag === 'string' ? prevDiag : prevDiag?.direction;

  let nextDir: TableCellDiagonalDirection | undefined;
  if (diagonal !== undefined) {
    nextDir = diagonal === null ? undefined : diagonal;
  } else {
    if (!prevDir) {
      nextDir = 'down';
    } else if (prevDir === 'down') {
      nextDir = 'up';
    } else {
      nextDir = undefined;
    }
  }

  const { diagonal: _prevDiscard, ...restMeta } = prevMeta;
  const nextMeta: TableCellMeta = nextDir
    ? {
        ...restMeta,
        diagonal:
          typeof prevDiag === 'object'
            ? {
                ...prevDiag,
                direction: nextDir
              }
            : nextDir
      }
    : restMeta;

  const nextCellMeta: Record<string, TableCellMeta> = {
    ...(table.cellMeta ?? {}),
    [key]: nextMeta
  };

  const nextTable: TableNodeFields = {
    ...table,
    cellMeta: nextCellMeta
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

/** 设置或更新单元格斜线表头 (方向、颜色、样式、粗细) */
export function setCellDiagonalOperation(
  node: Readonly<NodeEntity>,
  row: number,
  col: number,
  diagonal?: TableCellDiagonalDirection | TableCellDiagonal | null
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  const table = getTableFields(node);
  const key = cellKey(row, col);
  const prevMeta = table.cellMeta?.[key] ?? {};
  const prevDiag = prevMeta.diagonal;

  let nextDiag: TableCellDiagonal | TableCellDiagonalDirection | undefined;
  if (diagonal === null || diagonal === undefined) {
    nextDiag = undefined;
  } else if (typeof diagonal === 'string') {
    if (typeof prevDiag === 'object') {
      nextDiag = { ...prevDiag, direction: diagonal };
    } else {
      nextDiag = diagonal;
    }
  } else {
    const prevObj = typeof prevDiag === 'object' ? prevDiag : prevDiag ? { direction: prevDiag } : undefined;
    const nextColor = 'color' in diagonal ? diagonal.color || undefined : prevObj?.color;
    nextDiag = {
      direction: diagonal.direction ?? prevObj?.direction ?? 'down',
      ...(nextColor ? { color: nextColor } : {}),
      width: diagonal.width !== undefined ? diagonal.width : prevObj?.width,
      style: diagonal.style !== undefined ? diagonal.style : prevObj?.style
    };
  }

  const { diagonal: _prevDiscard, ...restMeta } = prevMeta;
  const nextMeta: TableCellMeta =
    nextDiag !== undefined
      ? {
          ...restMeta,
          diagonal: nextDiag
        }
      : restMeta;

  const nextCellMeta: Record<string, TableCellMeta> = {
    ...(table.cellMeta ?? {}),
    [key]: nextMeta
  };

  const nextTable: TableNodeFields = {
    ...table,
    cellMeta: nextCellMeta
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

export type DirectionalBorderType =
  | 'all'
  | 'outside'
  | 'inside'
  | 'inside-horizontal'
  | 'inside-vertical'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'clear';

/** Word 同款定向边框设置 (全边框/外边框/内边框/内横/内竖/上/下/左/右/清除) */
export function applyDirectionalBordersOperation(
  node: Readonly<NodeEntity>,
  range: TableMergeRange,
  type: DirectionalBorderType,
  border: TableBorderSide = { width: 1, style: 'solid' }
): { updatedNode: NodeEntity; patch: CanvasPatch } {
  if (type === 'clear') {
    return clearCellBordersOperation(node, range);
  }

  const table = getTableFields(node);
  const minR = Math.max(0, Math.min(range.startRow, range.endRow));
  const maxR = Math.min(table.rowCount - 1, Math.max(range.startRow, range.endRow));
  const minC = Math.max(0, Math.min(range.startCol, range.endCol));
  const maxC = Math.min(table.columnCount - 1, Math.max(range.startCol, range.endCol));

  const nextCellMeta: Record<string, TableCellMeta> = { ...(table.cellMeta ?? {}) };

  const ensureCell = (r: number, c: number): string => {
    const key = cellKey(r, c);
    if (!nextCellMeta[key]) nextCellMeta[key] = {};
    if (!nextCellMeta[key].borders) nextCellMeta[key] = { ...nextCellMeta[key], borders: {} };
    return key;
  };

  const clearSide = (r: number, c: number, side: 'top' | 'bottom' | 'left' | 'right'): void => {
    const key = cellKey(r, c);
    const prev = nextCellMeta[key]?.borders;
    if (!prev || prev[side] === undefined) return;
    const rest = { ...prev };
    delete rest[side];
    nextCellMeta[key] = {
      ...nextCellMeta[key],
      borders: Object.keys(rest).length > 0 ? rest : undefined
    };
  };

  if (type === 'top' || type === 'outside' || type === 'all') {
    for (let c = minC; c <= maxC; c++) {
      const key = ensureCell(minR, c);
      nextCellMeta[key] = { ...nextCellMeta[key], borders: { ...nextCellMeta[key].borders, top: border } };
      if (minR > 0) clearSide(minR - 1, c, 'bottom');
    }
  }

  if (type === 'bottom' || type === 'outside' || type === 'all') {
    for (let c = minC; c <= maxC; c++) {
      const key = ensureCell(maxR, c);
      nextCellMeta[key] = { ...nextCellMeta[key], borders: { ...nextCellMeta[key].borders, bottom: border } };
      if (maxR < table.rowCount - 1) clearSide(maxR + 1, c, 'top');
    }
  }

  if (type === 'left' || type === 'outside' || type === 'all') {
    for (let r = minR; r <= maxR; r++) {
      const key = ensureCell(r, minC);
      nextCellMeta[key] = { ...nextCellMeta[key], borders: { ...nextCellMeta[key].borders, left: border } };
      if (minC > 0) clearSide(r, minC - 1, 'right');
    }
  }

  if (type === 'right' || type === 'outside' || type === 'all') {
    for (let r = minR; r <= maxR; r++) {
      const key = ensureCell(r, maxC);
      nextCellMeta[key] = { ...nextCellMeta[key], borders: { ...nextCellMeta[key].borders, right: border } };
      if (maxC < table.columnCount - 1) clearSide(r, maxC + 1, 'left');
    }
  }

  if (type === 'inside' || type === 'inside-horizontal' || type === 'all') {
    for (let r = minR; r < maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const key = ensureCell(r, c);
        nextCellMeta[key] = { ...nextCellMeta[key], borders: { ...nextCellMeta[key].borders, bottom: border } };
        clearSide(r + 1, c, 'top');
      }
    }
  }

  if (type === 'inside' || type === 'inside-vertical' || type === 'all') {
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c < maxC; c++) {
        const key = ensureCell(r, c);
        nextCellMeta[key] = { ...nextCellMeta[key], borders: { ...nextCellMeta[key].borders, right: border } };
        clearSide(r, c + 1, 'left');
      }
    }
  }

  const nextTable: TableNodeFields = {
    ...table,
    cellMeta: nextCellMeta
  };

  const updatedNode: NodeEntity = {
    ...node,
    table: nextTable
  };

  return {
    updatedNode,
    patch: { op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }
  };
}

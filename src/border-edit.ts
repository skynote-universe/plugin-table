import type { NodeEntity } from '@skynote/core';
import { buildMergeLookup } from './layout';
import { resolveTableBorder, type ResolvedTableBorder } from './border-resolver';
import {
  cellKey,
  type TableBorderSide,
  type TableBorderStyle,
  type TableCellBorders,
  type TableCellMeta,
  type TableGridStyleDefinition,
  type TableMergeRange
} from './types';

export type TableBorderScope = 'table' | 'outer' | 'inner' | 'cells';
export type TableBorderTarget = 'top' | 'bottom' | 'left' | 'right' | 'inside-horizontal' | 'inside-vertical';
export interface TableBorderEdit {
  readonly visible?: boolean;
  readonly color?: string | null;
  readonly width?: number;
  readonly style?: TableBorderStyle;
}
export interface TableBorderValues {
  readonly count: number;
  readonly visible: boolean | null;
  readonly color: string | null;
  readonly width: number | null;
  readonly style: TableBorderStyle | null;
}
interface Edge {
  axis: 'row' | 'column';
  boundary: number;
  index: number;
  target: TableBorderTarget;
}

function edges(
  node: Readonly<NodeEntity>,
  scope: TableBorderScope,
  targets: readonly TableBorderTarget[],
  range?: TableMergeRange
): Edge[] {
  const table = node.table!;
  const box =
    scope === 'cells'
      ? range!
      : { startRow: 0, endRow: table.rowCount - 1, startCol: 0, endCol: table.columnCount - 1 };
  const result: Edge[] = [];
  for (const target of new Set(targets)) {
    if ((scope === 'outer' && target.startsWith('inside-')) || (scope === 'inner' && !target.startsWith('inside-')))
      continue;
    if (target === 'top' || target === 'bottom') {
      for (let col = box.startCol; col <= box.endCol; col++)
        result.push({ axis: 'row', boundary: target === 'top' ? box.startRow : box.endRow + 1, index: col, target });
    } else if (target === 'left' || target === 'right') {
      for (let row = box.startRow; row <= box.endRow; row++)
        result.push({
          axis: 'column',
          boundary: target === 'left' ? box.startCol : box.endCol + 1,
          index: row,
          target
        });
    } else if (target === 'inside-horizontal') {
      for (let row = box.startRow + 1; row <= box.endRow; row++)
        for (let col = box.startCol; col <= box.endCol; col++)
          result.push({ axis: 'row', boundary: row, index: col, target });
    } else {
      for (let col = box.startCol + 1; col <= box.endCol; col++)
        for (let row = box.startRow; row <= box.endRow; row++)
          result.push({ axis: 'column', boundary: col, index: row, target });
    }
  }
  return result;
}

export function readTableBorders(
  node: Readonly<NodeEntity>,
  grid: TableGridStyleDefinition,
  base: ResolvedTableBorder,
  scope: TableBorderScope,
  targets: readonly TableBorderTarget[],
  range?: TableMergeRange
): TableBorderValues {
  if (!targets.length) return { count: 0, visible: null, color: null, width: null, style: null };
  const table = node.table!;
  const merges = buildMergeLookup(table.merges, table.rowCount, table.columnCount);
  const values = edges(node, scope, targets, range)
    .map((edge) => resolveTableBorder(table, grid, base, edge.axis, edge.boundary, edge.index, merges))
    .filter((value) => value !== null);
  const common = <K extends keyof ResolvedTableBorder>(key: K): ResolvedTableBorder[K] | null =>
    values.length && values.every((value) => value[key] === values[0][key]) ? values[0][key] : null;
  return {
    count: values.length,
    visible: common('visible'),
    color: common('color'),
    width: common('width'),
    style: common('style')
  };
}

/** 只合并本次修改属性；隐藏保留正数线宽，恢复显示不丢失原样式。 */
export function editTableBorders(
  node: Readonly<NodeEntity>,
  grid: TableGridStyleDefinition,
  base: ResolvedTableBorder,
  scope: TableBorderScope,
  targets: readonly TableBorderTarget[],
  edit: TableBorderEdit,
  range?: TableMergeRange
): NodeEntity | null {
  const changes = Object.fromEntries(
    Object.entries(edit).filter(([, value]) => value !== undefined)
  ) as TableBorderEdit;
  const table = node.table!;
  const merges = buildMergeLookup(table.merges, table.rowCount, table.columnCount);
  const selected = edges(node, scope, targets, range).filter(
    (edge) => resolveTableBorder(table, grid, base, edge.axis, edge.boundary, edge.index, merges) !== null
  );
  if (!selected.length || !Object.keys(changes).length) return null;
  const merge = (
    previous: TableBorderSide | undefined,
    resolved: ResolvedTableBorder,
    snapshot = true
  ): TableBorderSide => {
    const { color, ...fields } = changes;
    const next: TableBorderSide = {
      ...previous,
      visible: previous?.visible ?? (snapshot ? resolved.visible : undefined),
      ...fields,
      width: changes.width ?? (previous?.width === 0 ? resolved.width : previous?.width),
      ...(color !== undefined && color !== null ? { color } : {})
    };
    if (color === null) delete (next as { color?: string }).color;
    return next;
  };
  const cellMeta: Record<string, TableCellMeta> = { ...table.cellMeta };
  let outer = table.outerBorders;
  let inner = table.innerBorders;
  const seen = new Set<TableBorderTarget>();
  for (const edge of selected) {
    const resolved = resolveTableBorder(table, grid, base, edge.axis, edge.boundary, edge.index, merges)!;
    if (scope !== 'cells' && !seen.has(edge.target)) {
      seen.add(edge.target);
      const inherited = resolveTableBorder(table, grid, base, edge.axis, edge.boundary, edge.index, merges, false)!;
      if (!edge.target.startsWith('inside-')) {
        const side = edge.target as keyof TableCellBorders;
        outer = {
          ...outer,
          sideStyles: { ...outer?.sideStyles, [side]: merge(outer?.sideStyles?.[side], inherited, false) }
        };
      } else {
        const side = edge.target === 'inside-horizontal' ? 'horizontal' : 'vertical';
        inner = {
          ...inner,
          sideStyles: { ...inner?.sideStyles, [side]: merge(inner?.sideStyles?.[side], inherited, false) }
        };
      }
    }
    const rowAxis = edge.axis === 'row';
    const limit = rowAxis ? table.rowCount : table.columnCount;
    const locations: [number, number, keyof TableCellBorders][] = [];
    if (edge.boundary > 0)
      locations.push(rowAxis ? [edge.boundary - 1, edge.index, 'bottom'] : [edge.index, edge.boundary - 1, 'right']);
    if (edge.boundary < limit)
      locations.push(rowAxis ? [edge.boundary, edge.index, 'top'] : [edge.index, edge.boundary, 'left']);
    const preferred =
      edge.boundary === 0 || edge.boundary === limit
        ? cellMeta[cellKey(locations[0][0], locations[0][1])]?.borders?.[locations[0][2]]
        : rowAxis
          ? (cellMeta[cellKey(edge.boundary, edge.index)]?.borders?.top ??
            cellMeta[cellKey(edge.boundary - 1, edge.index)]?.borders?.bottom)
          : (cellMeta[cellKey(edge.index, edge.boundary)]?.borders?.left ??
            cellMeta[cellKey(edge.index, edge.boundary - 1)]?.borders?.right);
    // 单元格范围边界共享同一条物理边，双方已有覆盖同时更新，避免相邻格抢占。
    for (const [row, col, side] of locations) {
      const key = cellKey(row, col);
      const previous = cellMeta[key]?.borders?.[side];
      if (scope !== 'cells' && !previous) continue;
      cellMeta[key] = {
        ...cellMeta[key],
        borders: { ...cellMeta[key]?.borders, [side]: merge(previous ?? preferred, resolved) }
      };
    }
  }
  return {
    ...node,
    table: {
      ...table,
      outerBorders: outer,
      innerBorders: inner,
      ...(scope === 'cells' || table.cellMeta ? { cellMeta } : {})
    }
  };
}

/**
 * @file layout.ts
 * @description 表格几何标尺、前缀和数组、高效二分定位与合并单元格盒子求解
 *
 * 设计考量 (Why):
 * 1. 标尺数组 (Prefix Sums)：将宽高计算与单元格查询解耦，通过 rowStarts 与 colStarts 缓存行列累加边界，
 *    任意单元格外框查询 O(1)，局部坐标点击反查行与列 O(log R + log C)，彻底消除每帧网格遍历。
 * 2. 合并感知 (Merge-aware Boxes)：普通单元格直接取单行单列跨度；合并区域跨越对应标尺区间，
 *    被合并从属单元格自动标记 isCovered，不绘制内部网格线也不产生文本冲突。
 * 3. 零开销回退：未配置合并区域时直接跳过范围检索，无任何额外对象分配。
 */

import type { CanvasPrimitive } from '@skynote/core';
import { getTableGridStyle } from './grid-styles';
import { resolveTableBorder } from './border-resolver';
import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_ROW_HEIGHT,
  cellKey,
  type CellBox,
  type TableBorderStyle,
  type TableColumnMeta,
  type TableMergeRange,
  type TableNodeFields,
  type TableRowMeta,
  type TableGridStyle,
  type TableGridStyleDefinition,
  type TableTracks
} from './types';

export type { TableTracks } from './types';

/** 计算行列标尺 (前缀和数组)：纯函数，结果用于 O(1) 求解任何单元格位置与整表总尺寸 */
export function computeTableTracks(
  rowCount: number,
  columnCount: number,
  rows?: readonly TableRowMeta[],
  columns?: readonly TableColumnMeta[],
  defaultRowHeight = DEFAULT_ROW_HEIGHT,
  defaultColWidth = DEFAULT_COLUMN_WIDTH
): TableTracks {
  const safeRowCount = Math.max(1, rowCount);
  const safeColCount = Math.max(1, columnCount);

  const rowStarts = new Array<number>(safeRowCount + 1);
  rowStarts[0] = 0;
  const baseRowH = Math.max(MIN_ROW_HEIGHT, Math.round(defaultRowHeight));
  for (let r = 0; r < safeRowCount; r++) {
    const customH = rows?.[r]?.height;
    const h =
      customH !== undefined && Number.isFinite(customH) ? Math.max(MIN_ROW_HEIGHT, Math.round(customH)) : baseRowH;
    rowStarts[r + 1] = rowStarts[r] + h;
  }

  const colStarts = new Array<number>(safeColCount + 1);
  colStarts[0] = 0;
  const baseColW = Math.max(MIN_COLUMN_WIDTH, Math.round(defaultColWidth));
  for (let c = 0; c < safeColCount; c++) {
    const customW = columns?.[c]?.width;
    const w =
      customW !== undefined && Number.isFinite(customW) ? Math.max(MIN_COLUMN_WIDTH, Math.round(customW)) : baseColW;
    colStarts[c + 1] = colStarts[c] + w;
  }

  return {
    rowStarts,
    colStarts,
    totalWidth: colStarts[safeColCount],
    totalHeight: rowStarts[safeRowCount]
  };
}

/** 基于二分查找在递增标尺中定位索引 */
function binarySearchTrack(starts: readonly number[], val: number): number {
  const count = starts.length - 1;
  if (val < 0 || val >= starts[count]) return -1;
  let low = 0;
  let high = count - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (val >= starts[mid] && val < starts[mid + 1]) {
      return mid;
    }
    if (val < starts[mid]) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return -1;
}

export function nearestTableBoundary(starts: readonly number[], coordinate: number): number {
  if (coordinate <= starts[0]) return 0;
  const last = starts.length - 1;
  if (coordinate >= starts[last]) return last;
  const index = binarySearchTrack(starts, coordinate);
  return coordinate - starts[index] <= starts[index + 1] - coordinate ? index : index + 1;
}

/** 局部坐标反查单元格 (行、列)，超出表格范围返回 null */
export function findCellAtLocalPoint(
  tracks: TableTracks,
  localX: number,
  localY: number
): { row: number; col: number } | null {
  const row = binarySearchTrack(tracks.rowStarts, localY);
  if (row < 0) return null;
  const col = binarySearchTrack(tracks.colStarts, localX);
  if (col < 0) return null;
  return { row, col };
}

/** 合并区域索引器：加速单元格主从归属与越界校验 */
export interface TableMergeLookup {
  readonly byKey: ReadonlyMap<string, TableMergeRange>;
  readonly masterKeys: ReadonlySet<string>;
}

export function findTableMerge(
  merges: readonly TableMergeRange[] | undefined,
  row: number,
  col: number
): TableMergeRange | undefined {
  return merges?.find(
    (merge) => row >= merge.startRow && row <= merge.endRow && col >= merge.startCol && col <= merge.endCol
  );
}

export function expandTableRange(
  range: TableMergeRange,
  merges: readonly TableMergeRange[] | undefined
): TableMergeRange {
  let { startRow, startCol, endRow, endCol } = range;
  if (!merges?.length) return range;
  let changed: boolean;
  do {
    changed = false;
    for (const merge of merges) {
      if (merge.startRow > endRow || merge.endRow < startRow || merge.startCol > endCol || merge.endCol < startCol)
        continue;
      if (merge.startRow >= startRow && merge.endRow <= endRow && merge.startCol >= startCol && merge.endCol <= endCol)
        continue;
      startRow = Math.min(startRow, merge.startRow);
      startCol = Math.min(startCol, merge.startCol);
      endRow = Math.max(endRow, merge.endRow);
      endCol = Math.max(endCol, merge.endCol);
      changed = true;
    }
  } while (changed);
  return { startRow, startCol, endRow, endCol };
}

/** 规范化合并区域，剔除非法或越界范围 */
export function buildMergeLookup(
  merges?: readonly TableMergeRange[],
  rowCount = Infinity,
  colCount = Infinity
): TableMergeLookup | null {
  if (!merges || merges.length === 0) return null;
  const byKey = new Map<string, TableMergeRange>();
  const masterKeys = new Set<string>();

  for (const merge of merges) {
    const startRow = Math.max(0, Math.min(merge.startRow, merge.endRow));
    const endRow = Math.min(rowCount - 1, Math.max(merge.startRow, merge.endRow));
    const startCol = Math.max(0, Math.min(merge.startCol, merge.endCol));
    const endCol = Math.min(colCount - 1, Math.max(merge.startCol, merge.endCol));

    // 无效单格不计入合并
    if (startRow === endRow && startCol === endCol) continue;
    const normalized: TableMergeRange = { startRow, startCol, endRow, endCol };
    const masterKey = cellKey(startRow, startCol);
    masterKeys.add(masterKey);

    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        byKey.set(cellKey(r, c), normalized);
      }
    }
  }

  return { byKey, masterKeys };
}

/**
 * 求解指定单元格的外框与合并状态
 * - 若属于合并主格，尺寸跨越整个合并区域；
 * - 若属于被覆盖的从属格，isCovered = true；
 * - 普通单元格取标尺单格。
 */
export function getCellBox(
  row: number,
  col: number,
  tracks: TableTracks,
  mergeLookup?: TableMergeLookup | null
): CellBox {
  const merge = mergeLookup?.byKey.get(cellKey(row, col));
  if (merge) {
    const isMaster = merge.startRow === row && merge.startCol === col;
    const left = tracks.colStarts[merge.startCol];
    const top = tracks.rowStarts[merge.startRow];
    const right = tracks.colStarts[merge.endCol + 1];
    const bottom = tracks.rowStarts[merge.endRow + 1];
    return {
      row,
      col,
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      isMaster,
      isCovered: !isMaster,
      mergeRange: merge
    };
  }

  const left = tracks.colStarts[col];
  const top = tracks.rowStarts[row];
  const right = tracks.colStarts[col + 1];
  const bottom = tracks.rowStarts[row + 1];
  return {
    row,
    col,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    isMaster: true,
    isCovered: false
  };
}

export function parseBorderDash(style?: TableBorderStyle): number[] | undefined {
  if (style === 'dashed') return [4, 4];
  if (style === 'dotted') return [2, 2];
  return undefined;
}

function pushLineSegment(
  primitives: CanvasPrimitive[],
  points: [number, number, number, number],
  stroke: string,
  width: number,
  style?: TableBorderStyle
): void {
  if (width <= 0) return;
  if (style === 'double') {
    const [x1, y1, x2, y2] = points;
    const offset = Math.max(1, width);
    const subWidth = Math.max(0.75, width * 0.6);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const nx = -dy / len;
    const ny = dx / len;
    primitives.push({
      kind: 'line',
      points: [x1 + nx * offset, y1 + ny * offset, x2 + nx * offset, y2 + ny * offset],
      stroke,
      strokeWidth: subWidth
    });
    primitives.push({
      kind: 'line',
      points: [x1 - nx * offset, y1 - ny * offset, x2 - nx * offset, y2 - ny * offset],
      stroke,
      strokeWidth: subWidth
    });
    return;
  }

  primitives.push({
    kind: 'line',
    points,
    stroke,
    strokeWidth: width,
    strokeDashArray: parseBorderDash(style)
  });
}

/** 单条物理边界独立绘制，局部边框变化只重算相邻边界，同样式连续段合并。 */
export function composeTableBoundary(
  table: TableNodeFields,
  tracks: TableTracks,
  merges: TableMergeLookup | null,
  axis: 'row' | 'column',
  boundary: number,
  color: string,
  width: number,
  grid: TableGridStyleDefinition
): CanvasPrimitive[] {
  const result: CanvasPrimitive[] = [];
  const horizontal = axis === 'row';
  const starts = horizontal ? tracks.colStarts : tracks.rowStarts;
  const fixed = (horizontal ? tracks.rowStarts : tracks.colStarts)[boundary];
  let pending: { start: number; end: number; color: string; width: number; style: TableBorderStyle } | null = null;
  const flush = (): void => {
    if (!pending) return;
    pushLineSegment(
      result,
      horizontal ? [pending.start, fixed, pending.end, fixed] : [fixed, pending.start, fixed, pending.end],
      pending.color,
      pending.width,
      pending.style
    );
    pending = null;
  };
  for (let index = 0; index < starts.length - 1; index++) {
    const border = resolveTableBorder(
      table,
      grid,
      { visible: true, color, width, style: 'solid' },
      axis,
      boundary,
      index,
      merges
    );
    if (!border?.visible) {
      flush();
      continue;
    }
    if (pending && pending.color === border.color && pending.width === border.width && pending.style === border.style)
      pending.end = starts[index + 1];
    else {
      flush();
      pending = {
        start: starts[index],
        end: starts[index + 1],
        color: border.color,
        width: border.width,
        style: border.style
      };
    }
  }
  flush();
  return result;
}

export function composeTableDiagonal(
  table: TableNodeFields,
  row: number,
  col: number,
  tracks: TableTracks,
  merges: TableMergeLookup | null,
  color: string
): CanvasPrimitive[] {
  const diagonal = table.cellMeta?.[cellKey(row, col)]?.diagonal;
  const box = getCellBox(row, col, tracks, merges);
  if (!diagonal || box.isCovered) return [];
  const direction = typeof diagonal === 'string' ? diagonal : diagonal.direction;
  if (!direction) return [];
  const result: CanvasPrimitive[] = [];
  pushLineSegment(
    result,
    direction === 'down' ? [box.left, box.top, box.right, box.bottom] : [box.left, box.bottom, box.right, box.top],
    typeof diagonal === 'object' ? (diagonal.color ?? color) : color,
    typeof diagonal === 'object' ? (diagonal.width ?? 1) : 1,
    typeof diagonal === 'object' ? diagonal.style : undefined
  );
  return result;
}

/** 生成表格全部网格分割线图元 (支持学术三线表、无边框卡片、全网格风格、双实线、斜线表头与单元格独立边框) */
export function computeGridLinePrimitives(
  table: TableNodeFields,
  tracks: TableTracks,
  mergeLookup: TableMergeLookup | null,
  strokeColor: string,
  strokeWidth = 1,
  gridOrStyle: TableGridStyle | TableGridStyleDefinition = 'grid'
): CanvasPrimitive[] {
  const { rowCount, columnCount } = table;
  const primitives: CanvasPrimitive[] = [];
  const cellMeta = table.cellMeta;
  const hasCellBorders = Boolean(cellMeta && Object.values(cellMeta).some((m) => Boolean(m.borders)));
  const hasTableBorderConfig = Boolean(table.outerBorders || table.innerBorders || table.innerBorder !== undefined);
  const hasCustomBorders = hasCellBorders || hasTableBorderConfig;
  const grid = typeof gridOrStyle === 'object' ? gridOrStyle : getTableGridStyle(gridOrStyle);

  // 1. 斜线表头图元 (Cell Diagonal Lines)
  if (cellMeta) {
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < columnCount; c++) {
        const meta = cellMeta[cellKey(r, c)];
        if (!meta?.diagonal) continue;
        const box = getCellBox(r, c, tracks, mergeLookup);
        if (box.isCovered) continue;
        const diag = meta.diagonal;
        const direction = typeof diag === 'string' ? diag : diag.direction;
        const diagColor = typeof diag === 'object' && diag.color ? diag.color : strokeColor;
        const diagWidth = typeof diag === 'object' && diag.width !== undefined ? diag.width : 1;
        const diagStyle = typeof diag === 'object' && diag.style ? diag.style : 'solid';

        if (direction === 'down') {
          pushLineSegment(primitives, [box.left, box.top, box.right, box.bottom], diagColor, diagWidth, diagStyle);
        } else if (direction === 'up') {
          pushLineSegment(primitives, [box.left, box.bottom, box.right, box.top], diagColor, diagWidth, diagStyle);
        }
      }
    }
  }

  const base = { visible: true, color: strokeColor, width: strokeWidth, style: 'solid' as const };
  // 无合并和局部边框时，分方向样式在整条线上一致，避免整表设置退化为逐格线段。
  if (!hasCellBorders && (!mergeLookup || mergeLookup.byKey.size === 0)) {
    for (let r = 1; r < rowCount; r++) {
      const border = resolveTableBorder(table, grid, base, 'row', r, 0);
      if (border?.visible)
        pushLineSegment(
          primitives,
          [0, tracks.rowStarts[r], tracks.totalWidth, tracks.rowStarts[r]],
          border.color,
          border.width,
          border.style
        );
    }
    for (let c = 1; c < columnCount; c++) {
      const border = resolveTableBorder(table, grid, base, 'column', c, 0);
      if (border?.visible)
        pushLineSegment(
          primitives,
          [tracks.colStarts[c], 0, tracks.colStarts[c], tracks.totalHeight],
          border.color,
          border.width,
          border.style
        );
    }
    if (hasCustomBorders || grid.defaultOuterSides)
      appendOuterCustomBorders(primitives, table, tracks, strokeColor, strokeWidth, grid);
    return primitives;
  }

  for (let r = 1; r < rowCount; r++) {
    for (let c = 0; c < columnCount; c++) {
      const border = resolveTableBorder(table, grid, base, 'row', r, c, mergeLookup);
      if (border?.visible)
        pushLineSegment(
          primitives,
          [tracks.colStarts[c], tracks.rowStarts[r], tracks.colStarts[c + 1], tracks.rowStarts[r]],
          border.color,
          border.width,
          border.style
        );
    }
  }
  for (let c = 1; c < columnCount; c++) {
    for (let r = 0; r < rowCount; r++) {
      const border = resolveTableBorder(table, grid, base, 'column', c, r, mergeLookup);
      if (border?.visible)
        pushLineSegment(
          primitives,
          [tracks.colStarts[c], tracks.rowStarts[r], tracks.colStarts[c], tracks.rowStarts[r + 1]],
          border.color,
          border.width,
          border.style
        );
    }
  }

  // 4.4 单元格外边缘边框 (确保顶、底、左、右最外围单元格边线完整闭合显示)
  if (hasCustomBorders || grid.defaultOuterSides)
    appendOuterCustomBorders(primitives, table, tracks, strokeColor, strokeWidth, grid);

  return primitives;
}

/** 各种网格共用外围覆盖规则，并合并相邻的同样式线段。 */
function appendOuterCustomBorders(
  primitives: CanvasPrimitive[],
  table: TableNodeFields,
  tracks: TableTracks,
  strokeColor: string,
  strokeWidth: number,
  grid: TableGridStyleDefinition
): void {
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const horizontal = side === 'top' || side === 'bottom';
    const starts = horizontal ? tracks.colStarts : tracks.rowStarts;
    const count = horizontal ? table.columnCount : table.rowCount;
    const fixed = side === 'bottom' ? tracks.totalHeight : side === 'right' ? tracks.totalWidth : 0;
    let pending: { start: number; end: number; color: string; width: number; style?: TableBorderStyle } | null = null;
    const flush = (): void => {
      if (!pending) return;
      const points: [number, number, number, number] = horizontal
        ? [pending.start, fixed, pending.end, fixed]
        : [fixed, pending.start, fixed, pending.end];
      pushLineSegment(primitives, points, pending.color, pending.width, pending.style);
      pending = null;
    };
    for (let index = 0; index < count; index++) {
      const border = resolveTableBorder(
        table,
        grid,
        { visible: true, color: strokeColor, width: strokeWidth, style: 'solid' },
        horizontal ? 'row' : 'column',
        side === 'bottom' ? table.rowCount : side === 'right' ? table.columnCount : 0,
        index
      );
      const segmentWidth = border?.visible ? border.width : 0;
      const segmentColor = border?.color ?? strokeColor;
      const segmentStyle = border?.style;
      if (segmentWidth <= 0) {
        flush();
        continue;
      }
      if (
        pending &&
        pending.color === segmentColor &&
        pending.width === segmentWidth &&
        pending.style === segmentStyle
      ) {
        pending.end = starts[index + 1];
      } else {
        flush();
        pending = {
          start: starts[index],
          end: starts[index + 1],
          color: segmentColor,
          width: segmentWidth,
          style: segmentStyle
        };
      }
    }
    flush();
  }
}

/** 分割线命中检测结果 */
export interface TableDividerHit {
  readonly kind: 'column' | 'row';
  readonly index: number;
}

/**
 * 局部坐标反查行列分割线 (容差范围 tolerance 内)，用于行列宽高拖拽调整
 */
export function findDividerAtLocalPoint(
  tracks: TableTracks,
  localX: number,
  localY: number,
  tolerance = 4,
  toleranceY = tolerance
): TableDividerHit | null {
  // 1. 列分割线检测：位于 [0, totalHeight] 高度内，接近 colStarts[c + 1]
  if (localY >= 0 && localY <= tracks.totalHeight) {
    const boundary = nearestTableBoundary(tracks.colStarts, localX);
    if (boundary > 0 && Math.abs(localX - tracks.colStarts[boundary]) <= tolerance)
      return { kind: 'column', index: boundary - 1 };
  }

  // 2. 行分割线检测：位于 [0, totalWidth] 宽度内，接近 rowStarts[r + 1]
  if (localX >= 0 && localX <= tracks.totalWidth) {
    const boundary = nearestTableBoundary(tracks.rowStarts, localY);
    if (boundary > 0 && Math.abs(localY - tracks.rowStarts[boundary]) <= toleranceY)
      return { kind: 'row', index: boundary - 1 };
  }

  return null;
}

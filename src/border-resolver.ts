import {
  cellKey,
  type TableBorderSide,
  type TableBorderStyle,
  type TableNodeFields,
  type TableGridStyleDefinition
} from './types';
import type { TableMergeLookup } from './layout';

export interface ResolvedTableBorder {
  readonly visible: boolean;
  readonly color: string;
  readonly width: number;
  readonly style: TableBorderStyle;
}

/** 边界坐标：水平边用行边界与列号，垂直边用列边界与行号。读状态和绘制共用此优先级。 */
export function resolveTableBorder(
  table: TableNodeFields,
  grid: TableGridStyleDefinition,
  base: ResolvedTableBorder,
  axis: 'row' | 'column',
  boundary: number,
  index: number,
  merges?: TableMergeLookup | null,
  includeCells = true
): ResolvedTableBorder | null {
  const rows = axis === 'row';
  const count = rows ? table.rowCount : table.columnCount;
  const outer = boundary === 0 || boundary === count;
  const side = rows ? (boundary === 0 ? 'top' : 'bottom') : boundary === 0 ? 'left' : 'right';
  const key = rows ? 'horizontal' : 'vertical';
  if (!outer && merges) {
    const a = merges.byKey.get(rows ? cellKey(boundary - 1, index) : cellKey(index, boundary - 1));
    const b = merges.byKey.get(rows ? cellKey(boundary, index) : cellKey(index, boundary));
    if (a && a === b) return null;
  }
  const cfg = outer ? table.outerBorders : table.innerBorders;
  const own = outer ? table.outerBorders?.sideStyles?.[side] : table.innerBorders?.sideStyles?.[key];
  const region = outer
    ? rows
      ? boundary === 0
        ? grid.topBorder
        : grid.bottomBorder
      : undefined
    : rows
      ? boundary === 1
        ? grid.headerBottomBorder
        : table.totalRow && boundary === count - 1
          ? grid.totalTopBorder
          : undefined
      : boundary === 1
        ? grid.headerColRightBorder
        : undefined;
  const defaultVisible = outer
    ? (table.outerBorder ?? grid.defaultOuterBorder) &&
      (table.outerBorders?.[side] ?? grid.defaultOuterSides?.[side] ?? true)
    : table.innerBorder !== false &&
      (table.innerBorders?.[key] ??
        (rows ? ['grid', 'three-line', 'horizontal'].includes(grid.id) : grid.id === 'grid')) &&
      (grid.id !== 'three-line' || !rows || boundary === 1 || Boolean(table.totalRow && boundary === count - 1));
  let local: TableBorderSide | undefined;
  if (includeCells) {
    if (outer) {
      local =
        table.cellMeta?.[
          rows ? cellKey(boundary === 0 ? 0 : count - 1, index) : cellKey(index, boundary === 0 ? 0 : count - 1)
        ]?.borders?.[side];
    } else {
      local = rows
        ? (table.cellMeta?.[cellKey(boundary, index)]?.borders?.top ??
          table.cellMeta?.[cellKey(boundary - 1, index)]?.borders?.bottom)
        : (table.cellMeta?.[cellKey(index, boundary)]?.borders?.left ??
          table.cellMeta?.[cellKey(index, boundary - 1)]?.borders?.right);
    }
  }
  const inheritedWidth =
    own?.width ?? cfg?.width ?? region?.width ?? (outer ? grid.outerBorder?.width : undefined) ?? base.width;
  const rawWidth = local?.width ?? inheritedWidth;
  return {
    visible: local
      ? (local.visible ?? (!(outer && table.outerBorder === false) && rawWidth > 0))
      : (own?.visible ?? (defaultVisible && rawWidth > 0)),
    width: rawWidth > 0 ? rawWidth : inheritedWidth > 0 ? inheritedWidth : base.width,
    color:
      local?.color ??
      own?.color ??
      cfg?.color ??
      region?.color ??
      (outer ? grid.outerBorder?.color : undefined) ??
      base.color,
    style:
      local?.style ??
      own?.style ??
      cfg?.style ??
      region?.style ??
      (outer ? grid.outerBorder?.style : undefined) ??
      base.style
  };
}

/**
 * @file types.ts
 * @description 表格插件核心类型定义、数据模型与常量契约
 */

import type { RectBounds } from '@skynote/core';

export const TABLE_PLUGIN_ID = '@skynote-pro/plugin-table';
export const TABLE_PLUGIN_PRIORITY = 35;
export const TABLE_INPUT_SCOPE_ID = 'table:cell-selection';
export const TABLE_INPUT_SCOPE_PRIORITY = 60;

export const TABLE_NODE_TYPE = 'table';

export const DEFAULT_ROW_HEIGHT = 36;
export const DEFAULT_COLUMN_WIDTH = 100;
export const MIN_ROW_HEIGHT = 24;
export const MIN_COLUMN_WIDTH = 32;

export const DEFAULT_TABLE_ROWS = 3;
export const DEFAULT_TABLE_COLUMNS = 3;
export const MAX_TABLE_CELLS = 10_000;

/** 单元格槽位 ID 格式：'table:cell:r:c' */
export function tableCellSlot(row: number, col: number): string {
  return `table:cell:${row}:${col}`;
}

/** 解析单元格槽位 ID，非本表格格式返回 null */
export function parseTableCellSlot(slot: string): { row: number; col: number } | null {
  if (!slot.startsWith('table:cell:')) return null;
  const parts = slot.split(':');
  if (parts.length !== 4) return null;
  const row = Number.parseInt(parts[2], 10);
  const col = Number.parseInt(parts[3], 10);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) return null;
  return { row, col };
}

/** 单元格元数据键格式：'r,c' */
export function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

/** 解析单元格元数据键 */
export function parseCellKey(key: string): { row: number; col: number } | null {
  const parts = key.split(',');
  if (parts.length !== 2) return null;
  const row = Number.parseInt(parts[0], 10);
  const col = Number.parseInt(parts[1], 10);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) return null;
  return { row, col };
}

/** 单行元数据：稀疏覆盖默认行高 */
export interface TableRowMeta {
  readonly height?: number;
  /** 用户手动设定或基准最小行高，内容撑开后再缩小时回缩至此基准高度 */
  readonly minHeight?: number;
}

/** 单列元数据：稀疏覆盖默认列宽 */
export interface TableColumnMeta {
  readonly width?: number;
}

/** 边框线型 */
export type TableBorderStyle = 'solid' | 'dashed' | 'dotted' | 'double';

/** 边框单边样式配置 */
export interface TableBorderSide {
  readonly visible?: boolean;
  readonly color?: string;
  readonly width?: number;
  readonly style?: TableBorderStyle;
}

/** 单元格独立四周边框 */
export interface TableCellBorders {
  readonly top?: TableBorderSide;
  readonly right?: TableBorderSide;
  readonly bottom?: TableBorderSide;
  readonly left?: TableBorderSide;
}

/** 斜线表头拉伸方向：'down' 为从左上角拉至右下角，'up' 为从左下角拉至右上角 */
export type TableCellDiagonalDirection = 'down' | 'up';

/** 斜线表头完整样式配置 */
export interface TableCellDiagonal {
  readonly direction?: TableCellDiagonalDirection;
  readonly color?: string;
  readonly width?: number;
  readonly style?: TableBorderStyle;
}

/** 单元格文字溢出策略：'auto-height' 为跟随内容自动撑高，'ellipsis' 为固定行高超出显示省略号 */
export type TableCellOverflowMode = 'auto-height' | 'ellipsis';

/** 单元格元数据配置 */
export interface TableCellMeta {
  readonly fill?: string;
  readonly align?: 'left' | 'center' | 'right';
  readonly verticalAlign?: 'top' | 'middle' | 'bottom';
  readonly overflow?: TableCellOverflowMode;
  readonly borders?: TableCellBorders;
  /** 斜线表头：方向 'down' | 'up' 或完整 TableCellDiagonal 配置对象 */
  readonly diagonal?: TableCellDiagonalDirection | TableCellDiagonal;
}

/** 合并单元格矩形范围 [startRow, startCol] 至 [endRow, endCol] (包含两端) */
export interface TableMergeRange {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

/** 表格内置或外部注册的主题定义：与用户可配置属性严格对称的默认属性配置 */
export interface TableThemeDefinition {
  readonly id: string;
  readonly label: string;

  /** 默认结构开关：当 node.table 中未显式指定时采用此默认值 */
  readonly defaultHeaderRow?: boolean;
  readonly defaultHeaderColumn?: boolean;
  readonly defaultBandedRows?: boolean;
  readonly defaultTotalRow?: boolean;

  /** 基础与区域底色 (语义 Token 或色值) */
  readonly bodyFill?: string;
  readonly headerFill?: string;
  readonly headerColFill?: string;
  readonly bandedFill?: string;
  readonly bandedFillOpacity?: number;
  readonly totalFill?: string;

  /** 默认文字样式与对齐 */
  readonly headerText?: string;
  readonly headerColText?: string;
  readonly totalText?: string;
  readonly headerAlign?: 'left' | 'center' | 'right';
  readonly headerVerticalAlign?: 'top' | 'middle' | 'bottom';
  readonly bodyAlign?: 'left' | 'center' | 'right';
  readonly bodyVerticalAlign?: 'top' | 'middle' | 'bottom';

  /** 主题色同时用于默认框线，线条形状与粗细由独立网格样式决定。 */
  readonly strokeColor?: string;
}

export type TableGridStyle = 'grid' | 'three-line' | 'outline' | 'none' | 'horizontal';

/** 网格预设只定义线条形状，不绑定配色。 */
export interface TableGridStyleDefinition {
  readonly id: TableGridStyle;
  readonly label: string;
  readonly defaultOuterBorder: boolean;
  readonly defaultOuterSides?: TableOuterSides;
  readonly strokeWidth?: number;
  readonly strokeDash?: readonly number[];
  readonly topBorder?: TableBorderSide;
  readonly bottomBorder?: TableBorderSide;
  readonly headerBottomBorder?: TableBorderSide;
  readonly totalTopBorder?: TableBorderSide;
  readonly headerColRightBorder?: TableBorderSide;
  readonly outerBorder?: TableBorderSide;
}

/** 表格级独立外边框配置 (独立于单元格局部边框，始终作用于表格最外围四边) */
export interface TableOuterBorderConfig {
  readonly sideStyles?: TableCellBorders;
  readonly top?: boolean;
  readonly bottom?: boolean;
  readonly left?: boolean;
  readonly right?: boolean;
  readonly color?: string;
  readonly width?: number;
  readonly style?: TableBorderStyle;
}

/** 表格级独立内边框配置 (独立于单元格局部边框，始终作用于整表内部网格分割线) */
export interface TableInnerBorderConfig {
  readonly sideStyles?: { readonly horizontal?: TableBorderSide; readonly vertical?: TableBorderSide };
  readonly horizontal?: boolean;
  readonly vertical?: boolean;
  readonly color?: string;
  readonly width?: number;
  readonly style?: TableBorderStyle;
}

/** 表格节点具名强类型持久化字段 node.table */
export interface TableNodeFields {
  readonly rowCount: number;
  readonly columnCount: number;
  readonly themeId?: string;
  readonly themeColor?: string;
  readonly gridStyle?: TableGridStyle;
  readonly headerRow?: boolean;
  readonly headerColumn?: boolean;
  /** 隔行斑马纹交替底色开关 */
  readonly bandedRows?: boolean;
  /** 隔列斑马纹开关 */
  readonly bandedColumns?: boolean;
  /** 底部汇总行高亮开关 */
  readonly totalRow?: boolean;
  /** 表格外侧框线开关 (Word 同款) */
  readonly outerBorder?: boolean;
  /** 表格级独立外边框配置 */
  readonly outerBorders?: TableOuterBorderConfig;
  /** 表格内部框线总开关 */
  readonly innerBorder?: boolean;
  /** 表格级独立内边框配置 */
  readonly innerBorders?: TableInnerBorderConfig;
  /** 表格级默认单元格文字溢出策略 */
  readonly cellOverflow?: TableCellOverflowMode;
  readonly rows?: readonly TableRowMeta[];
  readonly columns?: readonly TableColumnMeta[];
  readonly cellMeta?: Readonly<Record<string, TableCellMeta>>;
  readonly merges?: readonly TableMergeRange[];
}

/** 创建表格请求参数 */
export interface TableCreateOptions {
  rowCount?: number;
  columnCount?: number;
  rowHeight?: number;
  columnWidth?: number;
  themeId?: string;
  themeColor?: string;
  gridStyle?: TableGridStyle;
  headerRow?: boolean;
  headerColumn?: boolean;
  bandedRows?: boolean;
  totalRow?: boolean;
  outerBorder?: boolean;
  headers?: readonly string[];
  cells?: readonly (readonly string[])[];
}

/** 标尺追踪结果：基于前缀和数组的高性能几何标尺 */
export interface TableTracks {
  /** 各行顶部相对表格原点的局部 Y 坐标，长度为 rowCount + 1 */
  readonly rowStarts: readonly number[];
  /** 各列左侧相对表格原点的局部 X 坐标，长度为 columnCount + 1 */
  readonly colStarts: readonly number[];
  readonly totalWidth: number;
  readonly totalHeight: number;
}

/** 单元格在表格局部坐标系中的几何包围盒及状态 */
export interface CellBox extends RectBounds {
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly height: number;
  /** 该单元格是否作为合并区域的主格 (拥有文字和主区域) */
  readonly isMaster: boolean;
  /** 该单元格是否属于被合并区域覆盖的从属单元格 (隐藏文字和内部边框) */
  readonly isCovered: boolean;
  /** 若被合并，指向其所属的合并范围定义 */
  readonly mergeRange?: TableMergeRange;
}

/** 表格四边外框独立配置 (用于单独控制表格上下左右外框线显示或隐藏) */
export interface TableOuterSides {
  readonly top?: boolean;
  readonly bottom?: boolean;
  readonly left?: boolean;
  readonly right?: boolean;
}

declare module '@skynote/core' {
  interface CustomNodeFields {
    readonly table?: TableNodeFields;
  }

  interface NodeCreateOptionsMap {
    [TABLE_NODE_TYPE]: TableCreateOptions;
  }
}

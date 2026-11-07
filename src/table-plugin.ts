/**
 * @file table-plugin.ts
 * @description 表格插件核心：独占指针手势认领 (claimPointer)、单元格多选高亮与连续键盘导航
 */

import {
  applyMatrix,
  generateId,
  getRunsText,
  measureTextBlock,
  resolveTextBlockStyle,
  invertMatrix,
  type CanvasKeyboardEvent,
  type CanvasPluginContext,
  type CanvasPointerEvent,
  type CanvasPrimitive,
  type ClipboardData,
  type ClipboardHandler,
  type InputScope,
  type NodeEntity,
  type Point,
  type PointerHooks,
  type RectBounds,
  type SkyNotePlugin
} from '@skynote/core';
import {
  editTableBorders,
  readTableBorders,
  type TableBorderEdit,
  type TableBorderScope,
  type TableBorderTarget,
  type TableBorderValues
} from './border-edit';
import { TableNodeType } from './table-node';
import { createTableStylePatches } from './style-patches';
import {
  MIN_COLUMN_WIDTH,
  MIN_ROW_HEIGHT,
  MAX_TABLE_CELLS,
  TABLE_INPUT_SCOPE_ID,
  TABLE_INPUT_SCOPE_PRIORITY,
  TABLE_PLUGIN_ID,
  TABLE_PLUGIN_PRIORITY,
  cellKey,
  parseTableCellSlot,
  tableCellSlot,
  type TableBorderSide,
  type TableCellBorders,
  type TableCellDiagonal,
  type TableCellDiagonalDirection,
  type TableCellOverflowMode,
  type TableNodeFields,
  type TableOuterSides,
  type TableGridStyle,
  type TableGridStyleDefinition,
  type TableThemeDefinition
} from './types';
import {
  buildMergeLookup,
  computeTableTracks,
  expandTableRange,
  findCellAtLocalPoint,
  findDividerAtLocalPoint,
  findTableMerge,
  getCellBox,
  type TableTracks
} from './layout';
import {
  applyDirectionalBordersOperation,
  clearCellBordersOperation,
  clearCellsFormattingOperation,
  clearTableFormattingOperation,
  distributeColumnsOperation,
  distributeRowsOperation,
  insertColumnsOperation,
  insertRowsOperation,
  mergeCellsOperation,
  removeColumnsOperation,
  removeRowsOperation,
  reorderTableTracks,
  resizeColumnOperation,
  resizeRowOperation,
  setCellAlignmentOperation,
  setCellBordersOperation,
  setCellDiagonalOperation,
  setCellFillOperation,
  setCellOverflowOperation,
  setInnerBordersOperation,
  setOuterBordersOperation,
  setTableThemeOperation,
  setTableGridStyleOperation,
  toggleBandedRowsOperation,
  toggleCellDiagonalOperation,
  toggleInnerBorderOperation,
  toggleOuterBorderOperation,
  toggleTotalRowOperation,
  unmergeCellsOperation,
  type DirectionalBorderType
} from './operations';
import { isTableThemeColor, tableThemeRegistry, withTableThemeColor } from './themes';
import { getTableGridStyle, TABLE_GRID_STYLES } from './grid-styles';
import { encodeTabularText, parseTabularText } from './tabular-text';
import {
  composeTableControls,
  hitTableControl,
  tableControlGeometry,
  tableInsertAnchor,
  type TableControlGeometry,
  type TableControlHit,
  type TableTrackAxis,
  type TableTrackSelection
} from './table-controls';

const OVERLAY_SESSION = 'table:selection-overlay';
const HANDLE_HOVER_SESSION = 'table:handle-hover';
const RESIZE_PREVIEW_SESSION = 'table:resize-preview';
const OUTER_BORDER_MARGIN = 6;

export interface ActiveCellSelection {
  readonly nodeId: string;
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

export interface TableControlTooltip {
  readonly text: string;
  readonly anchor: Point;
}

export class TablePlugin implements SkyNotePlugin, PointerHooks, InputScope, ClipboardHandler {
  readonly id = TABLE_PLUGIN_ID;
  readonly name = '表格插件';
  readonly version = '0.1.0';

  // InputScope 实现
  readonly priority = TABLE_INPUT_SCOPE_PRIORITY;

  private controlTooltip: TableControlTooltip | null = null;
  private readonly rejectionListeners = new Set<(reason: 'capacity' | 'invalid-paste') => void>();

  /** 只发布失败事实，由宿主统一提供提示。剪贴板返回值表示已消费输入，不表示写入成功。 */
  onOperationRejected(listener: (reason: 'capacity' | 'invalid-paste') => void): () => void {
    this.rejectionListeners.add(listener);
    return () => {
      this.rejectionListeners.delete(listener);
    };
  }

  private rejectOperation(reason: 'capacity' | 'invalid-paste'): false {
    for (const listener of this.rejectionListeners) listener(reason);
    return false;
  }
  private readonly controlTooltipListeners = new Set<(value: TableControlTooltip | null) => void>();

  /** 平台中立的提示锚点，由宿主使用统一 Tooltip 呈现。 */
  onControlTooltipChange(listener: (value: TableControlTooltip | null) => void): () => void {
    this.controlTooltipListeners.add(listener);
    listener(this.controlTooltip);
    return () => {
      this.controlTooltipListeners.delete(listener);
    };
  }

  private setControlTooltip(value: TableControlTooltip | null): void {
    const previous = this.controlTooltip;
    if (
      previous?.text === value?.text &&
      previous?.anchor.x === value?.anchor.x &&
      previous?.anchor.y === value?.anchor.y
    )
      return;
    this.controlTooltip = value;
    for (const listener of this.controlTooltipListeners) listener(value);
  }

  private ctx!: CanvasPluginContext;
  private readonly nodeType = new TableNodeType({
    dataVersion: (id) => this.ctx.entities.getNode(id)?.runtime.dataVersion,
    readScope: () => this.ctx.document.readScope
  });
  private activeSelection: ActiveCellSelection | null = null;
  private dragStart: { pointerId: number; localX: number; localY: number } | null = null;
  private trackDrag: {
    pointerId: number;
    nodeId: string;
    origin: Point;
    row: number;
    col: number;
    axis?: 'row' | 'column';
    offset: number;
  } | null = null;
  private resizeState: {
    pointerId: number;
    nodeId: string;
    dividerKind: 'column' | 'row';
    index: number;
    startCoord: number;
    startSize: number;
    targetSize: number;
    geometry: TableControlGeometry;
    inverse: ReturnType<typeof invertMatrix>;
  } | null = null;
  private hoveredTableId: string | null = null;
  private activeHandleNodeId: string | null = null;
  private controlHover: TableControlHit | null = null;
  private controlDrawKey = '';
  private controlTheme: CanvasPluginContext['session']['theme'] | null = null;
  private trackSelection: { nodeId: string; axis: TableTrackAxis; anchor: number } | null = null;
  private headerDrag: {
    pointerId: number;
    nodeId: string;
    axis: TableTrackAxis;
    anchor: number;
  } | null = null;
  private tableMoveDrag: { pointerId: number; nodeId: string; last: Point; groupId: string } | null = null;
  private readonly cellSelectionListeners = new Set<(sel: ActiveCellSelection | null) => void>();

  private getEditableTable(id: string): NodeEntity | undefined {
    const runtime = this.ctx.entities.getNode(id);
    const node = runtime?.entity;
    if (
      this.ctx.session.isReadOnly ||
      this.ctx.session.inMaintenance ||
      node?.locked ||
      node?.nodeType !== TableNodeType.TYPE
    )
      return undefined;
    return this.ctx.nodeTypes.validateNode(node, runtime?.runtime?.dataVersion) === null ? node : undefined;
  }

  copy(): ClipboardData | null {
    const selection = this.activeSelection;
    if (!selection || this.ctx.session.textEditing) return null;
    const node = this.ctx.entities.getNode(selection.nodeId)?.entity;
    if (!node?.table) return null;
    const rows = this.getCellTextRows(node, selection);
    return { 'text/plain': encodeTabularText(rows) };
  }

  cut(): ClipboardData | null {
    const data = this.copy();
    const node = this.activeSelection && this.getEditableTable(this.activeSelection.nodeId);
    if (data && node) this.clearSelectedCellsContent(node);
    return data;
  }

  paste(data: ClipboardData): boolean {
    const selection = this.activeSelection;
    if (!selection || this.ctx.session.textEditing) return false;
    const node = this.getEditableTable(selection.nodeId);
    if (!node) return true;
    const text = data['text/plain'];
    if (text === undefined) return false;
    const rows = parseTabularText(text) ?? (!/[\t\r\n]/.test(text) && text.length <= 1_048_576 ? [[text]] : null);
    if (rows)
      this.writeCellTextRows(
        node,
        rows,
        Math.min(selection.startRow, selection.endRow),
        Math.min(selection.startCol, selection.endCol)
      );
    else this.rejectOperation('invalid-paste');
    return true;
  }

  selectRows(nodeId: string): boolean {
    const node = this.getEditableTable(nodeId);
    const selection = this.activeSelection;
    if (!node?.table || selection?.nodeId !== nodeId) return false;
    this.selectTrackRange(node, 'row', selection.startRow, selection.endRow);
    return true;
  }

  selectColumns(nodeId: string): boolean {
    const node = this.getEditableTable(nodeId);
    const selection = this.activeSelection;
    if (!node?.table || selection?.nodeId !== nodeId) return false;
    this.selectTrackRange(node, 'column', selection.startCol, selection.endCol);
    return true;
  }

  moveSelectedTracks(nodeId: string, axis: 'row' | 'column', direction: -1 | 1): boolean {
    return this.moveTracksByOffset(nodeId, axis, direction);
  }

  private moveTracksByOffset(nodeId: string, axis: 'row' | 'column', offset: number): boolean {
    const node = this.getEditableTable(nodeId);
    const selection = this.activeSelection;
    if (!node?.table || selection?.nodeId !== nodeId) return false;
    const rows = axis === 'row';
    const start = rows
      ? Math.min(selection.startRow, selection.endRow)
      : Math.min(selection.startCol, selection.endCol);
    const end = rows ? Math.max(selection.startRow, selection.endRow) : Math.max(selection.startCol, selection.endCol);
    const count = rows ? node.table.rowCount : node.table.columnCount;
    if (!offset || start + offset < 0 || end + offset >= count) return false;
    const order = Array.from({ length: count }, (_, index) => index);
    const moved = order.splice(start, end - start + 1);
    order.splice(start + offset, 0, ...moved);
    if (!this.commitReorderedTracks(node, axis, order)) return false;
    if (this.trackSelection?.nodeId === nodeId && this.trackSelection.axis === axis)
      this.trackSelection.anchor += offset;
    this.updateCellSelection(
      nodeId,
      selection.startRow + (rows ? offset : 0),
      selection.startCol + (rows ? 0 : offset),
      selection.endRow + (rows ? offset : 0),
      selection.endCol + (rows ? 0 : offset)
    );
    return true;
  }

  private commitReorderedTracks(node: NodeEntity, axis: 'row' | 'column', order: readonly number[]): boolean {
    const next = reorderTableTracks(node, axis, order);
    if (!next) return false;
    return Boolean(
      this.ctx.document.commit({
        label: axis === 'row' ? '重排表格行' : '重排表格列',
        patches: [{ op: 'set', path: ['content', 'nodes', node.id], value: next }]
      })
    );
  }

  fitColumns(nodeId: string, columnIndex?: number, options?: { groupId?: string }): boolean {
    return this.fitTracks(nodeId, 'column', columnIndex, options);
  }

  fitRows(nodeId: string, options?: { groupId?: string }): boolean {
    return this.fitTracks(nodeId, 'row', undefined, options);
  }

  private fitTracks(
    nodeId: string,
    axis: TableTrackAxis,
    trackIndex?: number,
    options?: { groupId?: string }
  ): boolean {
    const node = this.getEditableTable(nodeId);
    const table = node?.table;
    const fonts = this.ctx.document.fonts;
    if (!node || !table || !fonts) return false;
    const count = axis === 'row' ? table.rowCount : table.columnCount;
    if (trackIndex !== undefined && (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= count))
      return false;
    const selection = this.activeSelection?.nodeId === nodeId ? this.activeSelection : null;
    const start =
      trackIndex ??
      (selection
        ? Math.min(
            axis === 'row' ? selection.startRow : selection.startCol,
            axis === 'row' ? selection.endRow : selection.endCol
          )
        : 0);
    const end =
      trackIndex ??
      (selection
        ? Math.max(
            axis === 'row' ? selection.startRow : selection.startCol,
            axis === 'row' ? selection.endRow : selection.endCol
          )
        : count - 1);
    const tracks = this.getControlGeometry(node).tracks;
    const starts = axis === 'row' ? tracks.rowStarts : tracks.colStarts;
    const sizes = Array.from({ length: count }, (_, index) =>
      index >= start && index <= end
        ? axis === 'row'
          ? MIN_ROW_HEIGHT
          : MIN_COLUMN_WIDTH
        : starts[index + 1] - starts[index]
    );
    const merges = buildMergeLookup(table.merges, table.rowCount, table.columnCount);
    const spans: { start: number; end: number; needed: number }[] = [];
    for (const block of node.textBlocks ?? []) {
      const pos = block.slot && parseTableCellSlot(block.slot);
      if (!pos) continue;
      const box = getCellBox(pos.row, pos.col, tracks, merges);
      if (box.isCovered) continue;
      const first = axis === 'row' ? pos.row : pos.col;
      const last = axis === 'row' ? (box.mergeRange?.endRow ?? first) : (box.mergeRange?.endCol ?? first);
      if (last < start || first > end) continue;
      const metrics = measureTextBlock(
        block,
        resolveTextBlockStyle(node, block, this.nodeType),
        axis === 'row' ? Math.max(0, box.width - 16) : undefined,
        fonts
      );
      const needed = Math.ceil(axis === 'row' ? metrics.height + 12 : metrics.width + 16);
      if (first === last) sizes[first] = Math.max(sizes[first], needed);
      else spans.push({ start: first, end: last, needed });
    }
    // 合并格不足的空间补到范围内末个行列，不改变未选中的行列。
    for (const span of spans) {
      let total = 0;
      for (let index = span.start; index <= span.end; index++) total += sizes[index];
      if (total < span.needed) sizes[Math.min(end, span.end)] += span.needed - total;
    }
    const rows =
      axis === 'row'
        ? sizes.map((height, index) =>
            index >= start && index <= end
              ? { ...table.rows?.[index], height, minHeight: height }
              : (table.rows?.[index] ?? {})
          )
        : table.rows;
    const columns =
      axis === 'column'
        ? sizes.map((width, index) =>
            index >= start && index <= end ? { ...table.columns?.[index], width } : (table.columns?.[index] ?? {})
          )
        : table.columns;
    const nextTracks = computeTableTracks(table.rowCount, table.columnCount, rows, columns);
    return Boolean(
      this.ctx.document.commit({
        label: options?.groupId ? '设置行高列宽' : axis === 'row' ? '按内容适应行高' : '按内容适应列宽',
        groupId: options?.groupId,
        patches: [
          {
            op: 'set',
            path: ['content', 'nodes', node.id],
            value: {
              ...node,
              width: nextTracks.totalWidth,
              height: nextTracks.totalHeight,
              table: { ...table, rows, columns }
            }
          }
        ]
      })
    );
  }
  private getCellTextRows(node: NodeEntity, range: ActiveCellSelection): string[][] {
    const table = node.table!;
    const merges = buildMergeLookup(table.merges, table.rowCount, table.columnCount);
    const bySlot = new Map(node.textBlocks?.map((block) => [block.slot, getRunsText(block.runs)]));
    const rows: string[][] = [];
    for (let row = Math.min(range.startRow, range.endRow); row <= Math.max(range.startRow, range.endRow); row++) {
      const values: string[] = [];
      for (let col = Math.min(range.startCol, range.endCol); col <= Math.max(range.startCol, range.endCol); col++) {
        const key = cellKey(row, col);
        values.push(
          merges?.byKey.has(key) && !merges.masterKeys.has(key) ? '' : (bySlot.get(tableCellSlot(row, col)) ?? '')
        );
      }
      rows.push(values);
    }
    return rows;
  }

  private writeCellTextRows(
    node: NodeEntity,
    rows: readonly (readonly string[])[],
    startRow: number,
    startCol: number,
    label = '粘贴表格内容'
  ): boolean {
    const table = node.table;
    if (!table || !rows.length) return false;
    const endRow = startRow + rows.length - 1;
    const endCol = startCol + rows.reduce((max, row) => Math.max(max, row.length), 0) - 1;
    const rowCount = Math.max(table.rowCount, endRow + 1);
    const colCount = Math.max(table.columnCount, endCol + 1);
    if (endCol < startCol) return false;
    if (rowCount * colCount > MAX_TABLE_CELLS) return this.rejectOperation('capacity');
    let next = node;
    if (rowCount > table.rowCount)
      next = insertRowsOperation(next, table.rowCount, rowCount - table.rowCount).updatedNode;
    if (colCount > table.columnCount)
      next = insertColumnsOperation(next, table.columnCount, colCount - table.columnCount).updatedNode;
    const merges = buildMergeLookup(next.table?.merges, rowCount, colCount);
    const textBlocks = next.textBlocks?.map((block) => {
      const pos = block.slot && parseTableCellSlot(block.slot);
      if (!pos) return block;
      const value = rows[pos.row - startRow]?.[pos.col - startCol];
      const key = cellKey(pos.row, pos.col);
      if (value === undefined || (merges?.byKey.has(key) && !merges.masterKeys.has(key))) return block;
      return { ...block, runs: [{ text: value }] };
    });
    const record = this.ctx.document.commit({
      label,
      patches: [{ op: 'set', path: ['content', 'nodes', node.id], value: { ...next, textBlocks } }]
    });
    if (!record) return false;
    this.updateCellSelection(node.id, startRow, startCol, endRow, endCol);
    return true;
  }

  private notifyCellSelectionChange(): void {
    const sel = this.activeSelection ? { ...this.activeSelection } : null;
    for (const listener of this.cellSelectionListeners) {
      try {
        listener(sel);
      } catch (err) {
        console.error('[TablePlugin] Error in cellSelectionListener', err);
      }
    }
  }

  onCellSelectionChange(listener: (sel: ActiveCellSelection | null) => void): () => void {
    this.cellSelectionListeners.add(listener);
    try {
      listener(this.activeSelection ? { ...this.activeSelection } : null);
    } catch (err) {
      console.error('[TablePlugin] Error in initial cellSelectionListener call', err);
    }
    return () => {
      this.cellSelectionListeners.delete(listener);
    };
  }

  getActiveCellSelection(): ActiveCellSelection | null {
    return this.activeSelection ? { ...this.activeSelection } : null;
  }

  getActiveCellBounds(): RectBounds | null {
    if (!this.activeSelection) return null;
    const node = this.ctx.entities.getNode(this.activeSelection.nodeId)?.entity;
    if (!node || node.nodeType !== TableNodeType.TYPE) return null;

    const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };
    const tracks = computeTableTracks(table.rowCount, table.columnCount, table.rows, table.columns);

    const minR = Math.max(0, Math.min(this.activeSelection.startRow, this.activeSelection.endRow));
    const maxR = Math.min(table.rowCount - 1, Math.max(this.activeSelection.startRow, this.activeSelection.endRow));
    const minC = Math.max(0, Math.min(this.activeSelection.startCol, this.activeSelection.endCol));
    const maxC = Math.min(table.columnCount - 1, Math.max(this.activeSelection.startCol, this.activeSelection.endCol));

    const merge = findTableMerge(table.merges, minR, minC);
    const left = tracks.colStarts[merge?.startCol ?? minC];
    const right = tracks.colStarts[Math.max(maxC, merge?.endCol ?? maxC) + 1];
    const top = tracks.rowStarts[merge?.startRow ?? minR];
    const bottom = tracks.rowStarts[Math.max(maxR, merge?.endRow ?? maxR) + 1];

    const m = this.ctx.entities.getWorldTransform?.(node.id);
    if (m && (m.b !== 0 || m.c !== 0)) {
      const p1 = applyMatrix(m, left, top);
      const p2 = applyMatrix(m, right, top);
      const p3 = applyMatrix(m, right, bottom);
      const p4 = applyMatrix(m, left, bottom);
      return {
        left: Math.min(p1.x, p2.x, p3.x, p4.x),
        top: Math.min(p1.y, p2.y, p3.y, p4.y),
        right: Math.max(p1.x, p2.x, p3.x, p4.x),
        bottom: Math.max(p1.y, p2.y, p3.y, p4.y)
      };
    }

    const pTopLeft = m ? applyMatrix(m, left, top) : { x: node.x + left, y: node.y + top };
    const pBottomRight = m ? applyMatrix(m, right, bottom) : { x: node.x + right, y: node.y + bottom };

    return {
      left: Math.min(pTopLeft.x, pBottomRight.x),
      top: Math.min(pTopLeft.y, pBottomRight.y),
      right: Math.max(pTopLeft.x, pBottomRight.x),
      bottom: Math.max(pTopLeft.y, pBottomRight.y)
    };
  }

  canMergeSelectedCells(): boolean {
    if (!this.activeSelection) return false;
    const minR = Math.min(this.activeSelection.startRow, this.activeSelection.endRow);
    const maxR = Math.max(this.activeSelection.startRow, this.activeSelection.endRow);
    const minC = Math.min(this.activeSelection.startCol, this.activeSelection.endCol);
    const maxC = Math.max(this.activeSelection.startCol, this.activeSelection.endCol);
    if (minR === maxR && minC === maxC) return false;
    const node = this.ctx.entities.getNode(this.activeSelection.nodeId)?.entity;
    const merge = findTableMerge(node?.table?.merges, minR, minC);
    return !(merge?.startRow === minR && merge.endRow === maxR && merge.startCol === minC && merge.endCol === maxC);
  }

  canUnmergeSelectedCells(): boolean {
    if (!this.activeSelection) return false;
    const node = this.ctx.entities.getNode(this.activeSelection.nodeId)?.entity;
    if (!node || !node.table?.merges || node.table.merges.length === 0) return false;
    const minR = Math.min(this.activeSelection.startRow, this.activeSelection.endRow);
    const minC = Math.min(this.activeSelection.startCol, this.activeSelection.endCol);
    const maxR = Math.max(this.activeSelection.startRow, this.activeSelection.endRow);
    const maxC = Math.max(this.activeSelection.startCol, this.activeSelection.endCol);
    return node.table.merges.some(
      (m) => m.startRow <= maxR && m.endRow >= minR && m.startCol <= maxC && m.endCol >= minC
    );
  }

  mergeSelectedCells(nodeId?: string): boolean {
    const sel = this.activeSelection;
    if (!sel || !this.canMergeSelectedCells()) return false;
    const targetId = nodeId ?? sel.nodeId;
    if (targetId !== sel.nodeId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;

    const minR = Math.min(sel.startRow, sel.endRow);
    const maxR = Math.max(sel.startRow, sel.endRow);
    const minC = Math.min(sel.startCol, sel.endCol);
    const maxC = Math.max(sel.startCol, sel.endCol);
    if (minR === maxR && minC === maxC) return false;

    const op = mergeCellsOperation(node, { startRow: minR, startCol: minC, endRow: maxR, endCol: maxC });
    if (!op) return false;

    const record = this.ctx.document.commit({
      label: '合并单元格',
      patches: [op.patch]
    });
    if (!record) return false;
    this.updateCellSelection(targetId, minR, minC, minR, minC);
    return true;
  }

  unmergeSelectedCells(nodeId?: string): boolean {
    const sel = this.activeSelection;
    if (!sel) return false;
    const targetId = nodeId ?? sel.nodeId;
    if (targetId !== sel.nodeId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;

    const range = expandTableRange(
      {
        startRow: Math.min(sel.startRow, sel.endRow),
        startCol: Math.min(sel.startCol, sel.endCol),
        endRow: Math.max(sel.startRow, sel.endRow),
        endCol: Math.max(sel.startCol, sel.endCol)
      },
      node.table?.merges
    );
    const op = unmergeCellsOperation(node, range.startRow, range.startCol, range.endRow, range.endCol);
    if (!op) return false;

    const record = this.ctx.document.commit({
      label: '拆分单元格',
      patches: [op.patch]
    });
    if (!record) return false;
    this.updateCellSelection(targetId, range.startRow, range.startCol, range.endRow, range.endCol);
    return true;
  }

  setCellFill(color: string | undefined, nodeId?: string): boolean {
    const sel = this.activeSelection;
    if (!sel) return false;
    const targetId = nodeId ?? sel.nodeId;
    if (targetId !== sel.nodeId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;

    const minR = Math.min(sel.startRow, sel.endRow);
    const maxR = Math.max(sel.startRow, sel.endRow);
    const minC = Math.min(sel.startCol, sel.endCol);
    const maxC = Math.max(sel.startCol, sel.endCol);

    const op = setCellFillOperation(node, { startRow: minR, startCol: minC, endRow: maxR, endCol: maxC }, color);
    this.ctx.document.commit({
      label: '设置单元格底色',
      patches: createTableStylePatches(node, op.updatedNode)
    });
    return true;
  }

  setCellBorders(borders: TableCellBorders, nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };

    const sel = this.activeSelection && this.activeSelection.nodeId === targetId ? this.activeSelection : null;
    const minR = sel ? Math.min(sel.startRow, sel.endRow) : 0;
    const maxR = sel ? Math.max(sel.startRow, sel.endRow) : table.rowCount - 1;
    const minC = sel ? Math.min(sel.startCol, sel.endCol) : 0;
    const maxC = sel ? Math.max(sel.startCol, sel.endCol) : table.columnCount - 1;

    const op = setCellBordersOperation(node, { startRow: minR, startCol: minC, endRow: maxR, endCol: maxC }, borders);
    this.ctx.document.commit({
      label: '设置单元格边框',
      patches: createTableStylePatches(node, op.updatedNode)
    });
    return true;
  }

  clearCellBorders(nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };

    const sel = this.activeSelection && this.activeSelection.nodeId === targetId ? this.activeSelection : null;
    const minR = sel ? Math.min(sel.startRow, sel.endRow) : 0;
    const maxR = sel ? Math.max(sel.startRow, sel.endRow) : table.rowCount - 1;
    const minC = sel ? Math.min(sel.startCol, sel.endCol) : 0;
    const maxC = sel ? Math.max(sel.startCol, sel.endCol) : table.columnCount - 1;

    const op = clearCellBordersOperation(node, { startRow: minR, startCol: minC, endRow: maxR, endCol: maxC });
    this.ctx.document.commit({
      label: '清除单元格边框',
      patches: createTableStylePatches(node, op.updatedNode)
    });
    return true;
  }

  insertRow(atIndex?: number, count = 1, nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };
    const selection = this.activeSelection?.nodeId === targetId ? this.activeSelection : null;
    const defaultIndex = selection ? Math.max(selection.startRow, selection.endRow) + 1 : table.rowCount;
    const index = Math.max(0, Math.min(atIndex ?? defaultIndex, table.rowCount));
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1) return false;
    if ((table.rowCount + count) * table.columnCount > MAX_TABLE_CELLS) return this.rejectOperation('capacity');
    const op = insertRowsOperation(node, index, count);
    const record = this.ctx.document.commit({
      label: '插入表格行',
      patches: [op.patch]
    });
    const sel = this.activeSelection;
    if (record && sel?.nodeId === targetId) {
      this.updateCellSelection(
        targetId,
        sel.startRow + (sel.startRow >= index ? count : 0),
        sel.startCol,
        sel.endRow + (sel.endRow >= index ? count : 0),
        sel.endCol
      );
    }
    return Boolean(record);
  }

  insertColumn(atIndex?: number, count = 1, nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };
    const selection = this.activeSelection?.nodeId === targetId ? this.activeSelection : null;
    const defaultIndex = selection ? Math.max(selection.startCol, selection.endCol) + 1 : table.columnCount;
    const index = Math.max(0, Math.min(atIndex ?? defaultIndex, table.columnCount));
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1) return false;
    if (table.rowCount * (table.columnCount + count) > MAX_TABLE_CELLS) return this.rejectOperation('capacity');
    const op = insertColumnsOperation(node, index, count);
    const record = this.ctx.document.commit({
      label: '插入表格列',
      patches: [op.patch]
    });
    const sel = this.activeSelection;
    if (record && sel?.nodeId === targetId) {
      this.updateCellSelection(
        targetId,
        sel.startRow,
        sel.startCol + (sel.startCol >= index ? count : 0),
        sel.endRow,
        sel.endCol + (sel.endCol >= index ? count : 0)
      );
    }
    return Boolean(record);
  }

  removeRow(atIndex?: number, count = 1, nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const selection = this.activeSelection?.nodeId === targetId ? this.activeSelection : null;
    const defaultIndex = selection ? Math.min(selection.startRow, selection.endRow) : (node.table?.rowCount ?? 1) - 1;
    const index = atIndex ?? defaultIndex;
    const op = removeRowsOperation(node, index, count);
    if (!op) return false;
    this.ctx.document.commit({
      label: '删除表格行',
      patches: [op.patch]
    });
    this.clearCellSelection();
    return true;
  }

  removeColumn(atIndex?: number, count = 1, nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const selection = this.activeSelection?.nodeId === targetId ? this.activeSelection : null;
    const defaultIndex = selection
      ? Math.min(selection.startCol, selection.endCol)
      : (node.table?.columnCount ?? 1) - 1;
    const index = atIndex ?? defaultIndex;
    const op = removeColumnsOperation(node, index, count);
    if (!op) return false;
    this.ctx.document.commit({
      label: '删除表格列',
      patches: [op.patch]
    });
    this.clearCellSelection();
    return true;
  }

  toggleHeaderRow(nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };
    const theme = tableThemeRegistry.getTheme(table.themeId);
    const currentVal = table.headerRow ?? theme.defaultHeaderRow ?? true;
    const nextHeaderRow = !currentVal;
    const nextTable: TableNodeFields = { ...table, headerRow: nextHeaderRow };
    const updatedNode: NodeEntity = { ...node, table: nextTable };
    this.ctx.document.commit({
      label: nextHeaderRow ? '开启表头行' : '关闭表头行',
      patches: [{ op: 'set', path: ['content', 'nodes', targetId], value: updatedNode }]
    });
    return true;
  }

  toggleHeaderColumn(nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };
    const theme = tableThemeRegistry.getTheme(table.themeId);
    const currentVal = table.headerColumn ?? theme.defaultHeaderColumn ?? false;
    const nextHeaderCol = !currentVal;
    const nextTable: TableNodeFields = { ...table, headerColumn: nextHeaderCol };
    const updatedNode: NodeEntity = { ...node, table: nextTable };
    this.ctx.document.commit({
      label: nextHeaderCol ? '开启首列高亮' : '关闭首列高亮',
      patches: [{ op: 'set', path: ['content', 'nodes', targetId], value: updatedNode }]
    });
    return true;
  }

  clearTableFormatting(nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const op = clearTableFormattingOperation(node);
    this.ctx.document.commit({
      label: '清除表格格式',
      patches: [op.patch]
    });
    this.renderSelectionOverlay();
    return true;
  }

  clearCellsFormatting(nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };

    const sel = this.activeSelection && this.activeSelection.nodeId === targetId ? this.activeSelection : null;
    if (!sel) return false;

    const minR = Math.min(sel.startRow, sel.endRow);
    const maxR = Math.max(sel.startRow, sel.endRow);
    const minC = Math.min(sel.startCol, sel.endCol);
    const maxC = Math.max(sel.startCol, sel.endCol);

    const op = clearCellsFormattingOperation(node, {
      startRow: Math.max(0, minR),
      startCol: Math.max(0, minC),
      endRow: Math.min(table.rowCount - 1, maxR),
      endCol: Math.min(table.columnCount - 1, maxC)
    });
    this.ctx.document.commit({
      label: '清除单元格格式',
      patches: [op.patch]
    });
    this.renderSelectionOverlay();
    return true;
  }

  setThemeColor(color: string | undefined, nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId || (color !== undefined && !isTableThemeColor(color))) return false;
    const node = this.getEditableTable(targetId);
    if (!node || node.table?.themeColor === color) return false;
    return Boolean(
      this.ctx.document.commit({
        label: '设置表格主题色',
        patches: [
          color === undefined
            ? { op: 'unset', path: ['content', 'nodes', targetId, 'table', 'themeColor'] }
            : { op: 'set', path: ['content', 'nodes', targetId, 'table', 'themeColor'], value: color }
        ]
      })
    );
  }

  setTheme(themeId: string, nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const op = setTableThemeOperation(node, themeId);
    this.ctx.document.commit({
      label: '切换表格主题',
      patches: [op.patch]
    });
    return true;
  }

  setGridStyle(style: TableGridStyle, nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId || !TABLE_GRID_STYLES.some((grid) => grid.id === style)) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const op = setTableGridStyleOperation(node, style);
    return Boolean(this.ctx.document.commit({ label: '切换表格网格框线', patches: [op.patch] }));
  }

  getGridStyle(style?: TableGridStyle): TableGridStyleDefinition {
    return getTableGridStyle(style);
  }

  listGridStyles(): readonly TableGridStyleDefinition[] {
    return TABLE_GRID_STYLES;
  }

  toggleBandedRows(nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const op = toggleBandedRowsOperation(node);
    this.ctx.document.commit({
      label: '切换隔行斑马纹',
      patches: [op.patch]
    });
    return true;
  }

  toggleTotalRow(nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const op = toggleTotalRowOperation(node);
    this.ctx.document.commit({
      label: '切换汇总行',
      patches: [op.patch]
    });
    return true;
  }

  toggleOuterBorder(nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const op = toggleOuterBorderOperation(node);
    this.ctx.document.commit({
      label: '切换表格外边框',
      patches: [op.patch]
    });
    return true;
  }

  setOuterBorders(sides: TableOuterSides, border?: TableBorderSide, nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const op = setOuterBordersOperation(node, sides, border);
    this.ctx.document.commit({
      label: '设置外边框',
      patches: [op.patch]
    });
    return true;
  }

  toggleInnerBorder(nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const op = toggleInnerBorderOperation(node);
    this.ctx.document.commit({
      label: '切换表格内边框',
      patches: [op.patch]
    });
    return true;
  }

  setInnerBorders(
    sides: { horizontal?: boolean; vertical?: boolean },
    border?: TableBorderSide,
    nodeId?: string
  ): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const op = setInnerBordersOperation(node, sides, border);
    this.ctx.document.commit({
      label: '设置内边框',
      patches: [op.patch]
    });
    return true;
  }

  getTrackSizes(nodeId: string): {
    rowHeight: number | null;
    columnWidth: number | null;
    minRowHeight: number;
    minColumnWidth: number;
  } | null {
    const node = this.getEditableTable(nodeId);
    if (!node) return null;
    const tracks = this.getControlGeometry(node).tracks;
    const selection = this.activeSelection?.nodeId === nodeId ? this.activeSelection : null;
    const uniform = (starts: readonly number[], start: number, end: number): number | null => {
      const size = starts[start + 1] - starts[start];
      for (let index = start + 1; index <= end; index++) {
        if (starts[index + 1] - starts[index] !== size) return null;
      }
      return size;
    };
    return {
      rowHeight: uniform(
        tracks.rowStarts,
        selection ? Math.min(selection.startRow, selection.endRow) : 0,
        selection ? Math.max(selection.startRow, selection.endRow) : node.table!.rowCount - 1
      ),
      columnWidth: uniform(
        tracks.colStarts,
        selection ? Math.min(selection.startCol, selection.endCol) : 0,
        selection ? Math.max(selection.startCol, selection.endCol) : node.table!.columnCount - 1
      ),
      minRowHeight: MIN_ROW_HEIGHT,
      minColumnWidth: MIN_COLUMN_WIDTH
    };
  }

  private borderContext(nodeId: string, scope: TableBorderScope) {
    const node = this.getEditableTable(nodeId);
    if (!node?.table) return null;
    const selection = this.activeSelection;
    if (scope === 'cells' && selection?.nodeId !== nodeId) return null;
    const range =
      scope === 'cells' && selection?.nodeId === nodeId
        ? expandTableRange(
            {
              startRow: Math.min(selection.startRow, selection.endRow),
              endRow: Math.max(selection.startRow, selection.endRow),
              startCol: Math.min(selection.startCol, selection.endCol),
              endCol: Math.max(selection.startCol, selection.endCol)
            },
            node.table.merges
          )
        : undefined;
    const theme = this.getTheme(node.table.themeId, node.table.themeColor);
    const grid = getTableGridStyle(node.table.gridStyle);
    return {
      node:
        node.table.totalRow === undefined && theme.defaultTotalRow
          ? { ...node, table: { ...node.table, totalRow: true } }
          : node,
      range,
      grid,
      base: {
        visible: true,
        color: node.style?.stroke ?? theme.strokeColor ?? this.ctx.session.theme.nodeStroke,
        width: node.style?.strokeWidth ?? grid.strokeWidth ?? 1,
        style: 'solid' as const
      }
    };
  }

  getBorderValues(
    nodeId: string,
    scope: TableBorderScope,
    targets: readonly TableBorderTarget[]
  ): TableBorderValues | null {
    const context = this.borderContext(nodeId, scope);
    return context ? readTableBorders(context.node, context.grid, context.base, scope, targets, context.range) : null;
  }

  editBorders(
    nodeId: string,
    scope: TableBorderScope,
    targets: readonly TableBorderTarget[],
    edit: TableBorderEdit,
    options?: { groupId?: string }
  ): boolean {
    if (edit.width !== undefined && (!Number.isFinite(edit.width) || edit.width <= 0)) return false;
    const context = this.borderContext(nodeId, scope);
    if (!context) return false;
    const next = editTableBorders(context.node, context.grid, context.base, scope, targets, edit, context.range);
    if (!next) return false;
    // 求值使用主题默认汇总行，提交保留文档原有的结构开关归属。
    const original = this.ctx.entities.getNode(nodeId)!.entity;
    const nextTable = { ...next.table! };
    if (Object.hasOwn(original.table!, 'totalRow')) nextTable.totalRow = original.table!.totalRow;
    else delete nextTable.totalRow;
    return Boolean(
      this.ctx.document.commit({
        label: '设置边框',
        groupId: options?.groupId,
        patches: createTableStylePatches(original, { ...next, table: nextTable })
      })
    );
  }

  setTrackSize(nodeId: string, axis: TableTrackAxis, size: number, options?: { groupId?: string }): boolean {
    const node = this.getEditableTable(nodeId);
    if (!node || (axis !== 'row' && axis !== 'column') || !Number.isFinite(size)) return false;
    const value = Math.round(size);
    if (!Number.isSafeInteger(value) || value < (axis === 'row' ? MIN_ROW_HEIGHT : MIN_COLUMN_WIDTH)) return false;
    const selection = this.activeSelection?.nodeId === nodeId ? this.activeSelection : null;
    const table = node.table!;
    const start = selection
      ? Math.min(
          axis === 'row' ? selection.startRow : selection.startCol,
          axis === 'row' ? selection.endRow : selection.endCol
        )
      : 0;
    const end = selection
      ? Math.max(
          axis === 'row' ? selection.startRow : selection.startCol,
          axis === 'row' ? selection.endRow : selection.endCol
        )
      : (axis === 'row' ? table.rowCount : table.columnCount) - 1;
    const current = this.getTrackSizes(nodeId);
    if ((axis === 'row' ? current?.rowHeight : current?.columnWidth) === value) return false;
    const rows =
      axis === 'row'
        ? Array.from({ length: table.rowCount }, (_, index) =>
            index >= start && index <= end
              ? { ...table.rows?.[index], height: value, minHeight: value }
              : (table.rows?.[index] ?? {})
          )
        : table.rows;
    const columns =
      axis === 'column'
        ? Array.from({ length: table.columnCount }, (_, index) =>
            index >= start && index <= end
              ? { ...table.columns?.[index], width: value }
              : (table.columns?.[index] ?? {})
          )
        : table.columns;
    const tracks = computeTableTracks(table.rowCount, table.columnCount, rows, columns);
    return Boolean(
      this.ctx.document.commit({
        label: options?.groupId ? '设置行高列宽' : axis === 'row' ? '设置表格行高' : '设置表格列宽',
        groupId: options?.groupId,
        patches: [
          {
            op: 'set',
            path: ['content', 'nodes', nodeId],
            value: {
              ...node,
              width: tracks.totalWidth,
              height: tracks.totalHeight,
              table: { ...table, rows, columns }
            }
          }
        ]
      })
    );
  }

  distributeColumns(nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const startCol =
      this.activeSelection && this.activeSelection.nodeId === targetId
        ? Math.min(this.activeSelection.startCol, this.activeSelection.endCol)
        : undefined;
    const endCol =
      this.activeSelection && this.activeSelection.nodeId === targetId
        ? Math.max(this.activeSelection.startCol, this.activeSelection.endCol)
        : undefined;
    const op = distributeColumnsOperation(node, startCol, endCol);
    this.ctx.document.commit({
      label: '平均分布各列',
      patches: [op.patch]
    });
    this.renderSelectionOverlay();
    return true;
  }

  distributeRows(nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const startRow =
      this.activeSelection && this.activeSelection.nodeId === targetId
        ? Math.min(this.activeSelection.startRow, this.activeSelection.endRow)
        : undefined;
    const endRow =
      this.activeSelection && this.activeSelection.nodeId === targetId
        ? Math.max(this.activeSelection.startRow, this.activeSelection.endRow)
        : undefined;
    const op = distributeRowsOperation(node, startRow, endRow);
    this.ctx.document.commit({
      label: '平均分布各行',
      patches: [op.patch]
    });
    this.renderSelectionOverlay();
    return true;
  }

  setCellAlignment(
    align?: 'left' | 'center' | 'right',
    verticalAlign?: 'top' | 'middle' | 'bottom',
    nodeId?: string
  ): boolean {
    const sel = this.activeSelection;
    if (!sel) return false;
    const targetId = nodeId ?? sel.nodeId;
    if (targetId !== sel.nodeId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;

    const minR = Math.min(sel.startRow, sel.endRow);
    const maxR = Math.max(sel.startRow, sel.endRow);
    const minC = Math.min(sel.startCol, sel.endCol);
    const maxC = Math.max(sel.startCol, sel.endCol);

    const op = setCellAlignmentOperation(
      node,
      { startRow: minR, startCol: minC, endRow: maxR, endCol: maxC },
      align,
      verticalAlign
    );
    this.ctx.document.commit({
      label: '设置对齐方式',
      patches: createTableStylePatches(node, op.updatedNode)
    });
    return true;
  }

  setCellOverflow(overflow: TableCellOverflowMode, nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };

    const sel = this.activeSelection && this.activeSelection.nodeId === targetId ? this.activeSelection : null;
    const minR = sel ? Math.min(sel.startRow, sel.endRow) : 0;
    const maxR = sel ? Math.max(sel.startRow, sel.endRow) : table.rowCount - 1;
    const minC = sel ? Math.min(sel.startCol, sel.endCol) : 0;
    const maxC = sel ? Math.max(sel.startCol, sel.endCol) : table.columnCount - 1;

    const op = setCellOverflowOperation(node, { startRow: minR, startCol: minC, endRow: maxR, endCol: maxC }, overflow);
    this.ctx.document.commit({
      label: '设置单元格文字溢出策略',
      patches: createTableStylePatches(node, op.updatedNode)
    });
    return true;
  }

  toggleCellDiagonal(nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;

    const sel = this.activeSelection && this.activeSelection.nodeId === targetId ? this.activeSelection : null;
    const minR = sel ? Math.min(sel.startRow, sel.endRow) : 0;
    const minC = sel ? Math.min(sel.startCol, sel.endCol) : 0;
    const op = toggleCellDiagonalOperation(node, minR, minC);
    this.ctx.document.commit({
      label: '切换斜线表头',
      patches: createTableStylePatches(node, op.updatedNode)
    });
    return true;
  }

  setCellDiagonal(diagonal?: TableCellDiagonalDirection | TableCellDiagonal | null, nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;

    const sel = this.activeSelection && this.activeSelection.nodeId === targetId ? this.activeSelection : null;
    const minR = sel ? Math.min(sel.startRow, sel.endRow) : 0;
    const minC = sel ? Math.min(sel.startCol, sel.endCol) : 0;
    const op = setCellDiagonalOperation(node, minR, minC, diagonal);
    this.ctx.document.commit({
      label: '设置斜线表头',
      patches: createTableStylePatches(node, op.updatedNode)
    });
    return true;
  }

  applyDirectionalBorders(type: DirectionalBorderType, border?: TableBorderSide, nodeId?: string): boolean {
    const targetId = nodeId ?? this.activeSelection?.nodeId ?? [...this.ctx.session.selectedNodeIds][0];
    if (!targetId) return false;
    const node = this.getEditableTable(targetId);
    if (!node) return false;
    const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };

    const sel = this.activeSelection && this.activeSelection.nodeId === targetId ? this.activeSelection : null;
    const minR = sel ? Math.min(sel.startRow, sel.endRow) : 0;
    const maxR = sel ? Math.max(sel.startRow, sel.endRow) : table.rowCount - 1;
    const minC = sel ? Math.min(sel.startCol, sel.endCol) : 0;
    const maxC = sel ? Math.max(sel.startCol, sel.endCol) : table.columnCount - 1;

    const op = applyDirectionalBordersOperation(
      node,
      { startRow: minR, startCol: minC, endRow: maxR, endCol: maxC },
      type,
      border
    );
    this.ctx.document.commit({
      label: '设置边框',
      patches: createTableStylePatches(node, op.updatedNode)
    });
    return true;
  }

  registerTheme(theme: TableThemeDefinition): void {
    tableThemeRegistry.registerTheme(theme);
  }

  getTheme(id?: string, color?: string): TableThemeDefinition {
    const theme = tableThemeRegistry.getTheme(id);
    return color === undefined ? theme : withTableThemeColor(theme, color, this.ctx.session.theme);
  }

  listThemes(): readonly TableThemeDefinition[] {
    return tableThemeRegistry.listThemes();
  }

  get inputScopeId(): string {
    return TABLE_INPUT_SCOPE_ID;
  }

  install(ctx: CanvasPluginContext): void {
    this.ctx = ctx;
    ctx.registerNodeType(this.nodeType);
    ctx.registerPointerHooks(this, TABLE_PLUGIN_PRIORITY);
    // 分界控件先于文字命中，双击调整宽度时避免进入相邻单元格的文字编辑。
    ctx.registerPointerHooks(
      {
        onPointerDown: (event) => {
          if (
            event.isClaimed ||
            event.button !== 0 ||
            this.ctx.session.tool !== 'select' ||
            (!this.ctx.session.textEditing && event.clickCount !== 2)
          )
            return;
          const control = this.controlAt(event.point);
          if (control) {
            this.ctx.session.setTextEditing(null);
            this.hoveredTableId = control.node.id;
            this.pressControl(control.node, control.hit, event);
            return;
          }
          const hit = this.ctx.hitTestNode(event.point);
          const node = hit && this.getEditableTable(hit.id);
          if (!node || event.modifiers.alt) return;
          const geometry = this.getControlGeometry(node);
          const local = this.toTableLocal(node, event.point);
          const divider = findDividerAtLocalPoint(
            geometry.tracks,
            local.x,
            local.y,
            4 * geometry.unitX,
            4 * geometry.unitY
          );
          if (divider) {
            this.ctx.session.setTextEditing(null);
            this.beginResize(node, divider.kind, divider.index, event);
          }
        }
      },
      80
    );
    ctx.registerInputScope(this);
    ctx.registerClipboardHandler(this, TABLE_PLUGIN_PRIORITY);

    // 选区变化时，若表格不再被选中，自动清除单元格选区高亮并同步顶部把手显隐
    ctx.onSessionChange((change) => {
      if (change.viewportChanged && this.resizeState) this.finishResize(false);
      if (change.readOnlyChanged || change.maintenanceChanged || change.toolChanged) {
        this.onBlur();
      }
      const editing = ctx.session.textEditing;
      if (change.textEditingChanged && editing?.kind === 'node') {
        this.trackSelection = null;
        const pos = parseTableCellSlot(editing.blockId);
        if (pos && ctx.entities.getNode(editing.id)?.entity.nodeType === TableNodeType.TYPE) {
          this.setSingleCellSelection(editing.id, pos.row, pos.col);
        }
      }
      if (
        change.viewportChanged ||
        change.themeChanged ||
        change.toolChanged ||
        change.readOnlyChanged ||
        change.maintenanceChanged
      ) {
        this.controlDrawKey = '';
        this.syncTopHandle();
      }
      if (change.toggledNodeIds.size > 0 || change.toggledConnectorIds.size > 0 || change.selectionScopeChanged) {
        const gestureNode =
          this.headerDrag?.nodeId ?? this.tableMoveDrag?.nodeId ?? this.trackDrag?.nodeId ?? this.resizeState?.nodeId;
        if (gestureNode && !ctx.session.selectedNodeIds.has(gestureNode)) this.onBlur();
        if (this.activeSelection) {
          const selected = ctx.session.selectedNodeIds;
          if (
            selected.size !== 1 ||
            !selected.has(this.activeSelection.nodeId) ||
            ctx.session.selectedConnectorIds.size > 0
          ) {
            this.clearCellSelection();
          }
        }
        this.syncTopHandle();
      }
    });

    // 文档变化时同步核对
    ctx.onDocumentChange((changes) => {
      const resizing = this.resizeState?.nodeId;
      if (
        resizing &&
        (changes.contentReplaced ||
          changes.nodes.removed.has(resizing) ||
          changes.nodes.worldGeometry.has(resizing) ||
          changes.nodes.data.has(resizing))
      )
        this.finishResize(false);
      const trackId = this.trackDrag?.nodeId;
      if (
        trackId &&
        (changes.nodes.removed.has(trackId) || changes.nodes.geometry.has(trackId) || changes.nodes.data.has(trackId))
      ) {
        this.finishTrackDrag(false);
      }
      if (this.activeSelection) {
        if (changes.nodes.removed.has(this.activeSelection.nodeId)) {
          this.clearCellSelection();
        } else if (
          changes.nodes.geometry.has(this.activeSelection.nodeId) ||
          changes.nodes.data.has(this.activeSelection.nodeId)
        ) {
          const { nodeId, startRow, startCol, endRow, endCol } = this.activeSelection;
          if (this.getEditableTable(nodeId)) this.updateCellSelection(nodeId, startRow, startCol, endRow, endCol);
          else this.clearCellSelection();
        }
      }
      if (this.activeHandleNodeId) {
        if (changes.nodes.removed.has(this.activeHandleNodeId)) {
          this.clearTopHandle();
        } else if (
          changes.nodes.geometry.has(this.activeHandleNodeId) ||
          changes.nodes.data.has(this.activeHandleNodeId)
        ) {
          this.controlDrawKey = '';
          this.syncTopHandle();
        }
      }
    });
  }

  unmount(): void {
    this.finishResize(false);
    if (this.trackDrag) this.ctx.host?.releasePointer?.(this.trackDrag.pointerId);
    if (this.headerDrag) this.ctx.host?.releasePointer?.(this.headerDrag.pointerId);
    if (this.tableMoveDrag) this.ctx.host?.releasePointer?.(this.tableMoveDrag.pointerId);
    if (this.dragStart) this.ctx.host?.releasePointer?.(this.dragStart.pointerId);
    this.ctx.host.overlay.clear(OVERLAY_SESSION);
    this.clearTopHandle();
    this.clearCellSelection();
    this.resizeState = null;
    this.trackDrag = null;
    this.headerDrag = null;
    this.tableMoveDrag = null;
    this.dragStart = null;
    this.hoveredTableId = null;
    this.activeHandleNodeId = null;
    this.cellSelectionListeners.clear();
    this.controlTooltipListeners.clear();
    this.rejectionListeners.clear();
  }

  // ================= InputScope 键盘交互 =================

  onKeyDown(e: CanvasKeyboardEvent): boolean | void {
    if (e.isComposing || e.keyCode === 229) return;
    if (
      e.key === 'Escape' &&
      (this.headerDrag || this.tableMoveDrag || this.trackDrag || this.resizeState || this.dragStart)
    ) {
      this.onBlur();
      this.clearCellSelection();
      this.syncTopHandle();
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    if (!this.activeSelection) return;
    const node = this.ctx.entities.getNode(this.activeSelection.nodeId)?.entity;
    if (!node || node.nodeType !== TableNodeType.TYPE) {
      this.clearCellSelection();
      return;
    }

    const table: TableNodeFields = node.table ?? {
      rowCount: 1,
      columnCount: 1
    };

    const { startRow, startCol, endRow, endCol } = this.activeSelection;
    const currentMerge = findTableMerge(table.merges, endRow, endCol);

    // 1. Escape 退出单元格选区
    if (e.key === 'Escape') {
      this.clearCellSelection();
      e.preventDefault();
      e.stopPropagation();
      return true;
    }

    // 2. Delete / Backspace 清空选中区域内容
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.getEditableTable(node.id)) this.clearSelectedCellsContent(node);
      e.preventDefault();
      e.stopPropagation();
      return true;
    }

    // 3. Tab / Shift+Tab 横向导航 (最末单元格按 Tab 自动新增一行)
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      if (!this.getEditableTable(node.id)) return true;
      const direction = e.shiftKey ? -1 : 1;
      const merges = buildMergeLookup(table.merges, table.rowCount, table.columnCount);
      const count = table.rowCount * table.columnCount;
      const current = (currentMerge?.startRow ?? endRow) * table.columnCount + (currentMerge?.startCol ?? endCol);
      let index = current + direction;
      for (; index >= 0 && index < count; index += direction) {
        const key = cellKey(Math.floor(index / table.columnCount), index % table.columnCount);
        if (!merges?.byKey.has(key) || merges.masterKeys.has(key)) break;
      }
      if (index < 0) return true;
      if (index === count) {
        if (count + table.columnCount > MAX_TABLE_CELLS) return true;
        const op = insertRowsOperation(node, table.rowCount, 1);
        if (!this.ctx.document.commit({ label: '表格自动追加行', patches: [op.patch] })) return true;
      }
      const row = Math.floor(index / table.columnCount);
      const col = index % table.columnCount;
      this.setSingleCellSelection(node.id, row, col);
      this.ctx.session.requestTextEditing(node.id, tableCellSlot(row, col));
      return true;
    }

    if (e.key === 'F2') {
      if (this.getEditableTable(node.id)) this.ctx.session.requestTextEditing(node.id, tableCellSlot(endRow, endCol));
      e.preventDefault();
      return true;
    }

    // 4. Enter 向下导航
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const nextR = Math.min(table.rowCount - 1, (currentMerge?.endRow ?? endRow) + 1);
      this.setSingleCellSelection(node.id, nextR, endCol);
      return true;
    }

    // 5. 方向键导航与 Shift 选区扩张
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      let dr = 0;
      let dc = 0;
      if (e.key === 'ArrowUp') dr = -1;
      if (e.key === 'ArrowDown') dr = 1;
      if (e.key === 'ArrowLeft') dc = -1;
      if (e.key === 'ArrowRight') dc = 1;

      if (e.shiftKey) {
        // 区域扩选
        const nextEndR = Math.max(0, Math.min(table.rowCount - 1, endRow + dr));
        const nextEndC = Math.max(0, Math.min(table.columnCount - 1, endCol + dc));
        this.updateCellSelection(node.id, startRow, startCol, nextEndR, nextEndC);
      } else {
        // 单格移动
        const baseRow = dr > 0 ? (currentMerge?.endRow ?? endRow) : (currentMerge?.startRow ?? endRow);
        const baseCol = dc > 0 ? (currentMerge?.endCol ?? endCol) : (currentMerge?.startCol ?? endCol);
        const nextR = Math.max(0, Math.min(table.rowCount - 1, baseRow + dr));
        const nextC = Math.max(0, Math.min(table.columnCount - 1, baseCol + dc));
        this.setSingleCellSelection(node.id, nextR, nextC);
      }
      return true;
    }
  }

  onBlur(): void {
    if (this.dragStart) {
      this.ctx.host?.releasePointer?.(this.dragStart.pointerId);
      this.dragStart = null;
      this.renderSelectionOverlay();
    }
    if (this.trackDrag) this.finishTrackDrag(false);
    if (this.headerDrag) this.ctx.host.releasePointer(this.headerDrag.pointerId);
    if (this.tableMoveDrag) this.ctx.host.releasePointer(this.tableMoveDrag.pointerId);
    this.finishResize(false);
    this.headerDrag = null;
    this.tableMoveDrag = null;
    this.resizeState = null;
    this.controlHover = null;
    this.syncTopHandle();
  }

  // ================= 顶部拖拽把手与悬停高亮辅助 =================

  private getTargetTableForHandle(): NodeEntity | null {
    if (this.ctx.session.tool !== 'select') return null;
    const selected = this.ctx.session.selectedNodeIds;
    if (selected.size === 1) {
      const node = this.getEditableTable([...selected][0]);
      if (node) return node;
    }
    return this.hoveredTableId ? (this.getEditableTable(this.hoveredTableId) ?? null) : null;
  }

  private getControlGeometry(node: NodeEntity): TableControlGeometry {
    const matrix = this.ctx.entities.getWorldTransform?.(node.id) ?? { a: 1, b: 0, c: 0, d: 1, e: node.x, f: node.y };
    return tableControlGeometry(node, matrix, this.ctx.session.viewport.zoom);
  }

  private controlAt(point: Point): { node: NodeEntity; geometry: TableControlGeometry; hit: TableControlHit } | null {
    if (this.ctx.session.tool !== 'select') return null;
    const hitNode = this.ctx.hitTestNode(point);
    const ids = new Set([
      ...(hitNode?.nodeType === TableNodeType.TYPE ? [hitNode.id] : []),
      ...(this.activeHandleNodeId ? [this.activeHandleNodeId] : []),
      ...(this.hoveredTableId ? [this.hoveredTableId] : []),
      ...(this.ctx.session.selectedNodeIds.size === 1 ? this.ctx.session.selectedNodeIds : [])
    ]);
    if (!hitNode) {
      const distance = 60 / this.ctx.session.viewport.zoom;
      for (const id of this.ctx.spatial.search({
        left: point.x - distance,
        top: point.y - distance,
        right: point.x + distance,
        bottom: point.y + distance
      }))
        ids.add(id);
    }
    for (const id of ids) {
      if (hitNode && hitNode.id !== id && !this.ctx.session.selectedNodeIds.has(id)) continue;
      const node = this.getEditableTable(id);
      if (!node) continue;
      const geometry = this.getControlGeometry(node);
      const hit = hitTableControl(geometry, this.toTableLocal(node, point));
      if (hit) return { node, geometry, hit };
    }
    return null;
  }

  private syncTopHandle(): void {
    const node = this.getTargetTableForHandle();
    if (node) this.renderControls(node);
    else this.clearTopHandle();
  }

  private renderControls(node: NodeEntity, guide?: { axis: TableTrackAxis; index: number }): void {
    const geometry = this.getControlGeometry(node);
    const versions = this.ctx.entities.getNode(node.id)?.runtime;
    const matrix = geometry.matrix;
    const selection = this.getActiveTrackSelection();
    const hover = this.controlHover;
    const key = [
      node.id,
      node.width,
      node.height,
      versions?.geomVersion,
      versions?.dataVersion,
      matrix.a,
      matrix.b,
      matrix.c,
      matrix.d,
      matrix.e,
      matrix.f,
      geometry.zoom,
      hover?.kind,
      hover && hover.kind !== 'move' ? hover.axis : '',
      hover && hover.kind !== 'move' ? hover.index : '',
      hover?.kind === 'insert' && hover.append,
      selection?.axis,
      selection?.start,
      selection?.end,
      guide?.axis,
      guide?.index
    ].join('|');
    const theme = this.ctx.session.theme;
    if (key === this.controlDrawKey && theme === this.controlTheme) return;
    this.controlDrawKey = key;
    this.controlTheme = theme;
    this.activeHandleNodeId = node.id;
    this.setControlTooltip(
      hover?.kind === 'insert'
        ? {
            text: hover.axis === 'column' ? '插入列' : '插入行',
            anchor: tableInsertAnchor(geometry, hover)
          }
        : null
    );
    this.ctx.host.overlay.setPrimitives(
      HANDLE_HOVER_SESSION,
      composeTableControls(geometry, theme, hover, selection, guide),
      { transient: true }
    );
  }

  private clearTopHandle(): void {
    this.setControlTooltip(null);
    if (this.activeHandleNodeId) this.ctx.host.overlay.clear(HANDLE_HOVER_SESSION);
    this.activeHandleNodeId = null;
    this.controlDrawKey = '';
    this.controlTheme = null;
    this.controlHover = null;
  }

  getActiveTrackSelection(): TableTrackSelection | null {
    const track = this.trackSelection;
    const selection = this.activeSelection;
    if (!track || selection?.nodeId !== track.nodeId) return null;
    return {
      nodeId: track.nodeId,
      axis: track.axis,
      start:
        track.axis === 'row'
          ? Math.min(selection.startRow, selection.endRow)
          : Math.min(selection.startCol, selection.endCol),
      end:
        track.axis === 'row'
          ? Math.max(selection.startRow, selection.endRow)
          : Math.max(selection.startCol, selection.endCol)
    };
  }

  private selectTrackRange(node: NodeEntity, axis: TableTrackAxis, anchor: number, end: number): void {
    if (
      this.ctx.session.selectedNodeIds.size !== 1 ||
      !this.ctx.session.selectedNodeIds.has(node.id) ||
      this.ctx.session.selectedConnectorIds.size > 0
    ) {
      this.ctx.session.setSelection({ nodeIds: [node.id], connectorIds: [] });
    }
    const previous = this.activeSelection;
    this.trackSelection = { nodeId: node.id, axis, anchor };
    if (axis === 'row') this.updateCellSelection(node.id, anchor, 0, end, node.table!.columnCount - 1, false);
    else this.updateCellSelection(node.id, 0, anchor, node.table!.rowCount - 1, end, false);
    if (previous !== this.activeSelection) this.renderSelectionOverlay();
    this.renderControls(node);
  }

  /** 宿主在表格外侧右键时先调用，保留控件对应的行列语义。 */
  selectEdgeAt(point: Point): string | null {
    const control = this.controlAt(point);
    if (!control || control.hit.kind === 'move' || control.hit.kind === 'insert') return null;
    const { node, hit } = control;
    const index = hit.index;
    const selection = this.getActiveTrackSelection();
    if (
      selection?.nodeId !== node.id ||
      selection.axis !== hit.axis ||
      index < selection.start ||
      index > selection.end
    ) {
      this.selectTrackRange(node, hit.axis, index, index);
    }
    return node.id;
  }

  private beginResize(node: NodeEntity, axis: TableTrackAxis, index: number, e: CanvasPointerEvent): void {
    this.controlHover = { kind: 'resize', axis, index };
    e.claimPointer(this.id);
    this.ctx.session.setSelection({ nodeIds: [node.id], connectorIds: [] });
    const geometry = this.getControlGeometry(node);
    const local = this.toTableLocal(node, e.point);
    if (axis === 'column' && e.clickCount === 2) {
      this.fitColumns(node.id, index);
      return;
    }
    const starts = axis === 'column' ? geometry.tracks.colStarts : geometry.tracks.rowStarts;
    this.ctx.host.capturePointer(e.pointerId);
    this.resizeState = {
      pointerId: e.pointerId,
      nodeId: node.id,
      dividerKind: axis,
      index,
      startCoord: axis === 'column' ? local.x : local.y,
      startSize: starts[index + 1] - starts[index],
      targetSize: starts[index + 1] - starts[index],
      geometry,
      inverse: invertMatrix(geometry.matrix)
    };
    const angle = (Math.atan2(geometry.matrix.b, geometry.matrix.a) * 180) / Math.PI;
    this.ctx.host.setCursor({ kind: 'resize', angle: angle + (axis === 'column' ? 0 : 90) });
  }

  /** 拖动只更新常量数量的参考线，避免反复校验、排版与重绘整张表格。 */
  private previewResize(point: Point): void {
    const drag = this.resizeState;
    if (!drag) return;
    const { geometry } = drag;
    const node = this.ctx.entities.getNode(drag.nodeId)?.entity;
    if (node !== geometry.node || this.ctx.session.isReadOnly || this.ctx.session.inMaintenance || node?.locked) {
      this.finishResize(false);
      return;
    }
    const local = applyMatrix(drag.inverse, point.x, point.y);
    const column = drag.dividerKind === 'column';
    const size = Math.max(
      column ? MIN_COLUMN_WIDTH : MIN_ROW_HEIGHT,
      Math.round(drag.startSize + (column ? local.x : local.y) - drag.startCoord)
    );
    if (size === drag.targetSize) return;
    drag.targetSize = size;
    const delta = size - drag.startSize;
    const width = node.width + (column ? delta : 0);
    const height = node.height + (column ? 0 : delta);
    const boundary = (column ? geometry.tracks.colStarts : geometry.tracks.rowStarts)[drag.index] + size;
    const project = (x: number, y: number) => applyMatrix(geometry.matrix, x, y);
    const a = project(column ? boundary : 0, column ? 0 : boundary);
    const b = project(column ? boundary : width, column ? height : boundary);
    const outline = [project(0, 0), project(width, 0), project(width, height), project(0, height)];
    const color = this.ctx.session.theme.selectionStroke;
    this.ctx.host.overlay.setPrimitives(
      RESIZE_PREVIEW_SESSION,
      [
        {
          kind: 'polygon',
          points: outline.flatMap((p) => [p.x, p.y]),
          stroke: color,
          strokeWidth: 1 / geometry.zoom,
          strokeOpacity: 0.4,
          strokeDashArray: [4 / geometry.zoom, 3 / geometry.zoom]
        },
        { kind: 'line', points: [a.x, a.y, b.x, b.y], stroke: color, strokeWidth: 1.5 / geometry.zoom }
      ],
      { transient: true }
    );
  }

  private finishResize(commit: boolean): void {
    const drag = this.resizeState;
    if (!drag) return;
    this.resizeState = null;
    this.ctx.host.releasePointer(drag.pointerId);
    this.ctx.host.setCursor('default');
    this.ctx.host.overlay.clear(RESIZE_PREVIEW_SESSION);
    const node = commit ? this.getEditableTable(drag.nodeId) : undefined;
    if (node && node === drag.geometry.node && drag.targetSize !== drag.startSize) {
      const operation =
        drag.dividerKind === 'column'
          ? resizeColumnOperation(node, drag.index, drag.targetSize)
          : resizeRowOperation(node, drag.index, drag.targetSize);
      if (operation)
        this.ctx.document.commit({
          label: drag.dividerKind === 'column' ? '调整列宽' : '调整行高',
          patches: [operation.patch]
        });
    }
    this.syncTopHandle();
  }

  private pressControl(node: NodeEntity, hit: TableControlHit, e: CanvasPointerEvent): void {
    e.claimPointer(this.id);
    this.controlHover = hit;
    if (hit.kind === 'insert') {
      const inserted =
        hit.axis === 'column' ? this.insertColumn(hit.index, 1, node.id) : this.insertRow(hit.index, 1, node.id);
      const updated = inserted && this.getEditableTable(node.id);
      if (updated) this.selectTrackRange(updated, hit.axis, hit.index, hit.index);
    } else if (hit.kind === 'resize') {
      this.beginResize(node, hit.axis, hit.index, e);
    } else if (hit.kind === 'move') {
      this.clearCellSelection();
      this.ctx.session.setSelection({ nodeIds: [node.id], connectorIds: [] });
      this.ctx.host.capturePointer(e.pointerId);
      this.tableMoveDrag = {
        pointerId: e.pointerId,
        nodeId: node.id,
        last: e.point,
        groupId: generateId('table-move')
      };
      this.ctx.host.setCursor('grabbing');
    } else {
      const selection = this.getActiveTrackSelection();
      const inside =
        selection?.nodeId === node.id &&
        selection.axis === hit.axis &&
        hit.index >= selection.start &&
        hit.index <= selection.end;
      if (inside && !e.modifiers.shift) {
        const geometry = this.getControlGeometry(node);
        const local = this.toTableLocal(node, e.point);
        const cell = findCellAtLocalPoint(
          geometry.tracks,
          Math.max(0, Math.min(node.width - 0.001, local.x)),
          Math.max(0, Math.min(node.height - 0.001, local.y))
        );
        this.trackDrag = {
          pointerId: e.pointerId,
          nodeId: node.id,
          origin: local,
          row: hit.axis === 'row' ? hit.index : cell!.row,
          col: hit.axis === 'column' ? hit.index : cell!.col,
          axis: hit.axis,
          offset: 0
        };
      } else {
        const anchor =
          e.modifiers.shift && this.trackSelection?.nodeId === node.id && this.trackSelection.axis === hit.axis
            ? this.trackSelection.anchor
            : hit.index;
        this.selectTrackRange(node, hit.axis, anchor, hit.index);
        this.headerDrag = { pointerId: e.pointerId, nodeId: node.id, axis: hit.axis, anchor };
      }
      this.ctx.host.capturePointer(e.pointerId);
    }
    this.syncTopHandle();
  }
  // ================= PointerHooks 指针手势 =================

  onPointerDown(e: CanvasPointerEvent): void {
    if (e.isClaimed || e.button !== 0) return;
    const control = this.controlAt(e.point);
    if (control) {
      this.hoveredTableId = control.node.id;
      this.pressControl(control.node, control.hit, e);
      return;
    }
    const hitNode = this.ctx.hitTestNode(e.point);
    if (!hitNode || hitNode.nodeType !== TableNodeType.TYPE) {
      this.clearCellSelection();
      this.hoveredTableId = null;
      this.syncTopHandle();
      return;
    }
    if (!this.getEditableTable(hitNode.id)) return;

    const m = this.ctx.entities.getWorldTransform?.(hitNode.id);
    const local = m
      ? applyMatrix(invertMatrix(m), e.point.x, e.point.y)
      : { x: e.point.x - hitNode.x, y: e.point.y - hitNode.y };
    const localX = local.x;
    const localY = local.y;

    const table: TableNodeFields = hitNode.table ?? {
      rowCount: 1,
      columnCount: 1
    };
    const tracks = computeTableTracks(table.rowCount, table.columnCount, table.rows, table.columns);

    // 2. 行列分割线判定：优先于单元格点击，进入实时调整列宽/行高手势
    const geometry = this.getControlGeometry(hitNode);
    const divider = findDividerAtLocalPoint(tracks, localX, localY, 4 * geometry.unitX, 4 * geometry.unitY);
    if (divider && !e.modifiers.alt) {
      this.beginResize(hitNode, divider.kind, divider.index, e);
      return;
    }

    // 3. 边缘判定：如果点击在外边框最外侧，属于整表选择/拖拽，不拦截指针
    const isOuterBorder =
      localX < OUTER_BORDER_MARGIN * geometry.unitX ||
      localX > hitNode.width - OUTER_BORDER_MARGIN * geometry.unitX ||
      localY > hitNode.height - OUTER_BORDER_MARGIN * geometry.unitY;

    if (isOuterBorder) {
      this.clearCellSelection();
      return;
    }

    // 4. 单元格定位与拖拽框选
    const hitCell = findCellAtLocalPoint(tracks, localX, localY);
    if (!hitCell) return;
    this.trackSelection = null;

    if (e.modifiers.alt) {
      if (this.ctx.session.selectedNodeIds.size !== 1 || !this.ctx.session.selectedNodeIds.has(hitNode.id)) {
        this.ctx.session.setSelection({ nodeIds: [hitNode.id], connectorIds: [] });
      }
      const selection = this.activeSelection;
      if (
        selection?.nodeId !== hitNode.id ||
        hitCell.row < Math.min(selection.startRow, selection.endRow) ||
        hitCell.row > Math.max(selection.startRow, selection.endRow) ||
        hitCell.col < Math.min(selection.startCol, selection.endCol) ||
        hitCell.col > Math.max(selection.startCol, selection.endCol)
      ) {
        this.setSingleCellSelection(hitNode.id, hitCell.row, hitCell.col);
      }
      e.claimPointer(this.id);
      this.ctx.host?.capturePointer?.(e.pointerId);
      this.trackDrag = {
        pointerId: e.pointerId,
        nodeId: hitNode.id,
        origin: local,
        row: hitCell.row,
        col: hitCell.col,
        offset: 0
      };
      return;
    }

    // 核心契约：认领指针，阻止画布框选与视口拖动
    e.claimPointer(this.id);
    this.ctx.host?.capturePointer?.(e.pointerId);
    this.dragStart = { pointerId: e.pointerId, localX, localY };

    // 确保所属表格节点被选中
    if (this.ctx.session.selectedNodeIds.size !== 1 || !this.ctx.session.selectedNodeIds.has(hitNode.id)) {
      this.ctx.session.setSelection({ nodeIds: [hitNode.id], connectorIds: [] });
    }

    if (e.modifiers.shift && this.activeSelection && this.activeSelection.nodeId === hitNode.id) {
      // Shift 点击扩展区域
      this.updateCellSelection(
        hitNode.id,
        this.activeSelection.startRow,
        this.activeSelection.startCol,
        hitCell.row,
        hitCell.col
      );
    } else {
      // 单击单选单元格
      this.setSingleCellSelection(hitNode.id, hitCell.row, hitCell.col);
    }
  }

  onPointerMove(e: CanvasPointerEvent): void {
    if (this.headerDrag) {
      const drag = this.headerDrag;
      if (drag.pointerId !== e.pointerId) return;
      e.claimPointer(this.id);
      const node = this.getEditableTable(drag.nodeId);
      if (!node) {
        this.onBlur();
        return;
      }
      const geometry = this.getControlGeometry(node);
      const local = this.toTableLocal(node, e.point);
      const cell = findCellAtLocalPoint(
        geometry.tracks,
        Math.max(0, Math.min(geometry.tracks.totalWidth - 0.001, local.x)),
        Math.max(0, Math.min(geometry.tracks.totalHeight - 0.001, local.y))
      );
      if (cell) this.selectTrackRange(node, drag.axis, drag.anchor, drag.axis === 'row' ? cell.row : cell.col);
      return;
    }
    if (this.tableMoveDrag) {
      const drag = this.tableMoveDrag;
      if (drag.pointerId !== e.pointerId) return;
      e.claimPointer(this.id);
      if (!this.getEditableTable(drag.nodeId)) {
        this.onBlur();
        return;
      }
      this.ctx.document.moveEntities(
        { nodeIds: [drag.nodeId] },
        { x: e.point.x - drag.last.x, y: e.point.y - drag.last.y },
        { groupId: drag.groupId, label: '移动表格' }
      );
      drag.last = e.point;
      this.ctx.host.setCursor('grabbing');
      return;
    }
    if (this.trackDrag) {
      if (e.pointerId === this.trackDrag.pointerId) {
        e.claimPointer(this.id);
        this.previewTrackDrag(e.point);
      }
      return;
    }
    // 1. 分割线轻量预览，松手后提交尺寸。
    if (this.resizeState) {
      if (e.pointerId !== this.resizeState.pointerId) return;
      e.claimPointer(this.id);
      this.previewResize(e.point);
      return;
    }

    // 2. 单元格拖拽实时选框与相交单元格高亮
    if (this.dragStart && this.activeSelection) {
      if (e.pointerId !== this.dragStart.pointerId) return;
      e.claimPointer(this.id);
      const node = this.ctx.entities.getNode(this.activeSelection.nodeId)?.entity;
      if (!node || node.nodeType !== TableNodeType.TYPE) return;

      const m = this.ctx.entities.getWorldTransform?.(node.id);
      const local = m
        ? applyMatrix(invertMatrix(m), e.point.x, e.point.y)
        : { x: e.point.x - node.x, y: e.point.y - node.y };
      const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };
      const tracks = computeTableTracks(table.rowCount, table.columnCount, table.rows, table.columns);

      // 计算实际拖拽选框包围盒 (在表格有效区域内)
      const clampedX = Math.max(0, Math.min(tracks.totalWidth, local.x));
      const clampedY = Math.max(0, Math.min(tracks.totalHeight, local.y));
      const boxLeft = Math.min(this.dragStart.localX, clampedX);
      const boxRight = Math.max(this.dragStart.localX, clampedX);
      const boxTop = Math.min(this.dragStart.localY, clampedY);
      const boxBottom = Math.max(this.dragStart.localY, clampedY);

      // 求解与实际矩形选框发生几何重叠的所有单元格
      let minR = Infinity;
      let maxR = -Infinity;
      let minC = Infinity;
      let maxC = -Infinity;

      for (let r = 0; r < table.rowCount; r++) {
        if (tracks.rowStarts[r] < boxBottom && tracks.rowStarts[r + 1] > boxTop) {
          minR = Math.min(minR, r);
          maxR = Math.max(maxR, r);
        }
      }
      for (let c = 0; c < table.columnCount; c++) {
        if (tracks.colStarts[c] < boxRight && tracks.colStarts[c + 1] > boxLeft) {
          minC = Math.min(minC, c);
          maxC = Math.max(maxC, c);
        }
      }

      if (minR === Infinity || minC === Infinity) {
        const hit = findCellAtLocalPoint(tracks, clampedX, clampedY);
        if (hit) {
          minR = maxR = hit.row;
          minC = maxC = hit.col;
        } else {
          minR = this.activeSelection.startRow;
          maxR = this.activeSelection.endRow;
          minC = this.activeSelection.startCol;
          maxC = this.activeSelection.endCol;
        }
      }

      this.updateCellSelection(node.id, minR, minC, maxR, maxC, false);

      // 实时渲染实际选框与相交单元格高亮
      this.renderDragSelectionOverlay(node, tracks, boxLeft, boxTop, boxRight, boxBottom, minR, maxR, minC, maxC);
      return;
    }

    if (!e.isClaimed) this.updateControlHover(e);
  }

  private updateControlHover(e: CanvasPointerEvent): void {
    const control = this.controlAt(e.point);
    if (control) {
      this.hoveredTableId = control.node.id;
      this.controlHover = control.hit;
      this.renderControls(control.node);
      if (control.hit.kind === 'resize') {
        const angle = (Math.atan2(control.geometry.matrix.b, control.geometry.matrix.a) * 180) / Math.PI;
        this.ctx.host.setCursor({ kind: 'resize', angle: angle + (control.hit.axis === 'column' ? 0 : 90) });
      } else {
        const selected = this.getActiveTrackSelection();
        const grabbed =
          control.hit.kind === 'move' ||
          (control.hit.kind === 'header' &&
            selected?.nodeId === control.node.id &&
            selected.axis === control.hit.axis &&
            control.hit.index >= selected.start &&
            control.hit.index <= selected.end);
        this.ctx.host.setCursor(grabbed ? 'grab' : 'pointer');
      }
      return;
    }
    const hit = this.ctx.hitTestNode(e.point);
    const node = hit?.nodeType === TableNodeType.TYPE ? this.getEditableTable(hit.id) : undefined;
    this.controlHover = null;
    if (node) {
      this.hoveredTableId = node.id;
      const geometry = this.getControlGeometry(node);
      const local = this.toTableLocal(node, e.point);
      const divider = findDividerAtLocalPoint(
        geometry.tracks,
        local.x,
        local.y,
        4 * geometry.unitX,
        4 * geometry.unitY
      );
      if (divider) {
        this.controlHover = { kind: 'resize', axis: divider.kind, index: divider.index };
        const angle = (Math.atan2(geometry.matrix.b, geometry.matrix.a) * 180) / Math.PI;
        this.ctx.host.setCursor({ kind: 'resize', angle: angle + (divider.kind === 'column' ? 0 : 90) });
      } else this.ctx.host.setCursor('default');
      this.renderControls(node);
    } else {
      const hadHover = this.hoveredTableId !== null;
      this.hoveredTableId = null;
      this.syncTopHandle();
      if (hadHover) this.ctx.host.setCursor('default');
    }
  }

  onPointerLeave(): void {
    if (this.headerDrag || this.tableMoveDrag || this.trackDrag || this.resizeState || this.dragStart) return;
    this.controlHover = null;
    this.hoveredTableId = null;
    this.syncTopHandle();
  }

  onContextMenu(e: CanvasPointerEvent): void {
    if (this.headerDrag || this.tableMoveDrag || this.trackDrag || this.resizeState || this.dragStart) {
      this.onBlur();
      e.stopPropagation?.();
    }
  }
  onPointerUp(e: CanvasPointerEvent): void {
    if (this.headerDrag?.pointerId === e.pointerId || this.tableMoveDrag?.pointerId === e.pointerId) {
      e.claimPointer(this.id);
      this.ctx.host.releasePointer(e.pointerId);
      this.headerDrag = null;
      this.tableMoveDrag = null;
      this.ctx.host.setCursor('default');
      this.syncTopHandle();
      return;
    }
    if (this.trackDrag) {
      if (e.pointerId === this.trackDrag.pointerId) this.finishTrackDrag(true);
      return;
    }
    if (this.resizeState) {
      if (e.pointerId !== this.resizeState.pointerId) return;
      e.claimPointer?.(this.id);
      this.previewResize(e.point);
      this.finishResize(true);
      return;
    }

    if (this.dragStart?.pointerId === e.pointerId) {
      this.ctx.host?.releasePointer?.(e.pointerId);
      this.dragStart = null;
      // 拖选完成，切换为固化的单元格选区高亮外框与定位小手柄
      this.renderSelectionOverlay();
    }

    this.syncTopHandle();
  }

  onPointerCancel(e: CanvasPointerEvent): void {
    if (this.resizeState) {
      if (e.pointerId === this.resizeState.pointerId) {
        e.claimPointer?.(this.id);
        this.finishResize(false);
      }
      return;
    }
    if (this.headerDrag?.pointerId === e.pointerId || this.tableMoveDrag?.pointerId === e.pointerId) {
      this.onPointerUp(e);
      return;
    }
    if (this.trackDrag) {
      if (e.pointerId === this.trackDrag.pointerId) this.finishTrackDrag(false);
      return;
    }
    this.onPointerUp(e);
  }

  private previewTrackDrag(point: Point): void {
    const drag = this.trackDrag;
    const selection = this.activeSelection;
    const node = drag && this.getEditableTable(drag.nodeId);
    if (!drag || !node?.table || selection?.nodeId !== drag.nodeId) {
      this.finishTrackDrag(false);
      return;
    }
    const local = this.toTableLocal(node, point);
    const dx = Math.abs(local.x - drag.origin.x);
    const dy = Math.abs(local.y - drag.origin.y);
    if (!drag.axis && Math.max(dx, dy) < 5 / this.ctx.session.viewport.zoom) return;
    drag.axis ??= dx > dy ? 'column' : 'row';
    const { rowCount, columnCount, rows, columns } = node.table;
    const tracks = computeTableTracks(rowCount, columnCount, rows, columns);
    const cell = findCellAtLocalPoint(
      tracks,
      Math.max(0, Math.min(tracks.totalWidth - 0.001, local.x)),
      Math.max(0, Math.min(tracks.totalHeight - 0.001, local.y))
    );
    if (!cell) return;
    const byRow = drag.axis === 'row';
    const min = byRow ? Math.min(selection.startRow, selection.endRow) : Math.min(selection.startCol, selection.endCol);
    const max = byRow ? Math.max(selection.startRow, selection.endRow) : Math.max(selection.startCol, selection.endCol);
    const count = byRow ? rowCount : columnCount;
    drag.offset = Math.max(-min, Math.min(count - 1 - max, byRow ? cell.row - drag.row : cell.col - drag.col));
    this.renderControls(node, {
      axis: drag.axis,
      index: drag.offset < 0 ? min + drag.offset : max + drag.offset + 1
    });
  }

  private finishTrackDrag(commit: boolean): void {
    const drag = this.trackDrag;
    if (!drag) return;
    this.trackDrag = null;
    this.ctx.host?.releasePointer?.(drag.pointerId);
    if (commit && drag.axis) this.moveTracksByOffset(drag.nodeId, drag.axis, drag.offset);
    this.renderSelectionOverlay();
    this.syncTopHandle();
  }

  private toTableLocal(node: NodeEntity, point: Point): Point {
    const matrix = this.ctx.entities.getWorldTransform?.(node.id);
    return matrix ? applyMatrix(invertMatrix(matrix), point.x, point.y) : { x: point.x - node.x, y: point.y - node.y };
  }

  // ================= 选区高亮与业务辅助 =================

  /**
   * 拖拽过程中：渲染真实橡皮筋选框 (精确跟随鼠标落点) 以及相交单元格的高亮背景
   */
  private renderDragSelectionOverlay(
    node: NodeEntity,
    tracks: TableTracks,
    boxLeft: number,
    boxTop: number,
    boxRight: number,
    boxBottom: number,
    minR: number,
    maxR: number,
    minC: number,
    maxC: number
  ): void {
    const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };
    const mergeLookup = buildMergeLookup(table.merges, table.rowCount, table.columnCount);
    const m = this.ctx.entities.getWorldTransform?.(node.id);
    const selectionColor = this.ctx.session.theme?.selectionStroke ?? '$accent';

    const primitives: CanvasPrimitive[] = [];

    // 1. 各相交单元格轻度背景高亮 (提供单元格归属感)
    const isTransformed = Boolean(m && (m.b !== 0 || m.c !== 0));
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const box = getCellBox(r, c, tracks, mergeLookup);
        if (box.isCovered) continue;
        if (isTransformed) {
          const c1 = applyMatrix(m!, box.left, box.top);
          const c2 = applyMatrix(m!, box.right, box.top);
          const c3 = applyMatrix(m!, box.right, box.bottom);
          const c4 = applyMatrix(m!, box.left, box.bottom);
          primitives.push({
            kind: 'polygon',
            points: [c1.x, c1.y, c2.x, c2.y, c3.x, c3.y, c4.x, c4.y],
            fill: selectionColor,
            fillOpacity: 0.08
          });
        } else {
          const p = m ? applyMatrix(m, box.left, box.top) : { x: node.x + box.left, y: node.y + box.top };
          primitives.push({
            kind: 'rect',
            x: p.x,
            y: p.y,
            width: box.width,
            height: box.height,
            fill: selectionColor,
            fillOpacity: 0.08
          });
        }
      }
    }

    // 2. 实际橡皮筋选框：精确对应鼠标拖拽矩形 [boxLeft, boxTop, boxRight, boxBottom]
    const p1 = m ? applyMatrix(m, boxLeft, boxTop) : { x: node.x + boxLeft, y: node.y + boxTop };
    const p2 = m ? applyMatrix(m, boxRight, boxTop) : { x: node.x + boxRight, y: node.y + boxTop };
    const p3 = m ? applyMatrix(m, boxRight, boxBottom) : { x: node.x + boxRight, y: node.y + boxBottom };
    const p4 = m ? applyMatrix(m, boxLeft, boxBottom) : { x: node.x + boxLeft, y: node.y + boxBottom };

    if (isTransformed) {
      primitives.push({
        kind: 'polygon',
        points: [p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y],
        fill: selectionColor,
        fillOpacity: 0.12,
        stroke: selectionColor,
        strokeWidth: 1.5
      });
    } else {
      primitives.push(
        {
          kind: 'rect',
          x: p1.x,
          y: p1.y,
          width: Math.max(1, boxRight - boxLeft),
          height: Math.max(1, boxBottom - boxTop),
          fill: selectionColor,
          fillOpacity: 0.12
        },
        {
          kind: 'rect',
          x: p1.x,
          y: p1.y,
          width: Math.max(1, boxRight - boxLeft),
          height: Math.max(1, boxBottom - boxTop),
          stroke: selectionColor,
          strokeWidth: 1.5
        }
      );
    }

    this.ctx.host.overlay.setPrimitives(OVERLAY_SESSION, primitives, { transient: true });
  }

  private setSingleCellSelection(nodeId: string, row: number, col: number): void {
    this.updateCellSelection(nodeId, row, col, row, col);
  }

  private updateCellSelection(
    nodeId: string,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    render = true
  ): void {
    const table = this.ctx.entities.getNode(nodeId)?.entity.table;
    if (!table) return;
    startRow = Math.min(table.rowCount - 1, Math.max(0, startRow));
    endRow = Math.min(table.rowCount - 1, Math.max(0, endRow));
    startCol = Math.min(table.columnCount - 1, Math.max(0, startCol));
    endCol = Math.min(table.columnCount - 1, Math.max(0, endCol));
    if (startRow === endRow && startCol === endCol) {
      const merge = findTableMerge(table.merges, startRow, startCol);
      if (merge) {
        startRow = endRow = merge.startRow;
        startCol = endCol = merge.startCol;
      }
    } else {
      const range = expandTableRange(
        {
          startRow: Math.min(startRow, endRow),
          endRow: Math.max(startRow, endRow),
          startCol: Math.min(startCol, endCol),
          endCol: Math.max(startCol, endCol)
        },
        table.merges
      );
      [startRow, endRow] = startRow <= endRow ? [range.startRow, range.endRow] : [range.endRow, range.startRow];
      [startCol, endCol] = startCol <= endCol ? [range.startCol, range.endCol] : [range.endCol, range.startCol];
    }
    const previous = this.activeSelection;
    if (
      !render &&
      previous?.nodeId === nodeId &&
      previous.startRow === startRow &&
      previous.startCol === startCol &&
      previous.endRow === endRow &&
      previous.endCol === endCol
    )
      return;
    this.activeSelection = { nodeId, startRow, startCol, endRow, endCol };
    const minR = Math.min(startRow, endRow);
    const maxR = Math.max(startRow, endRow);
    const minC = Math.min(startCol, endCol);
    const maxC = Math.max(startCol, endCol);
    const slotIds: string[] = [];
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        slotIds.push(tableCellSlot(r, c));
      }
    }
    this.ctx.session.setSelectedTextBlocks?.({ nodeId, blockIds: slotIds });
    if (render) this.renderSelectionOverlay();
    this.notifyCellSelectionChange();
  }

  clearCellSelection(): void {
    this.trackSelection = null;
    if (this.activeSelection) {
      this.activeSelection = null;
      this.ctx.session.setSelectedTextBlocks?.(null);
      this.ctx.host.overlay.clear(OVERLAY_SESSION);
      this.notifyCellSelectionChange();
    }
  }

  /** 在临时会话层绘制单元格选区高亮边框 */
  private renderSelectionOverlay(): void {
    if (!this.activeSelection) {
      this.ctx.host.overlay.clear(OVERLAY_SESSION);
      return;
    }

    const node = this.ctx.entities.getNode(this.activeSelection.nodeId)?.entity;
    if (!node || node.nodeType !== TableNodeType.TYPE) {
      this.ctx.host.overlay.clear(OVERLAY_SESSION);
      return;
    }

    const table: TableNodeFields = node.table ?? { rowCount: 1, columnCount: 1 };
    const tracks = computeTableTracks(table.rowCount, table.columnCount, table.rows, table.columns);
    const mergeLookup = buildMergeLookup(table.merges, table.rowCount, table.columnCount);

    const minR = Math.max(0, Math.min(this.activeSelection.startRow, this.activeSelection.endRow));
    const maxR = Math.min(table.rowCount - 1, Math.max(this.activeSelection.startRow, this.activeSelection.endRow));
    const minC = Math.max(0, Math.min(this.activeSelection.startCol, this.activeSelection.endCol));
    const maxC = Math.min(table.columnCount - 1, Math.max(this.activeSelection.startCol, this.activeSelection.endCol));

    // 计算跨越范围的联合包围盒
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;

    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const box = getCellBox(r, c, tracks, mergeLookup);
        left = Math.min(left, box.left);
        top = Math.min(top, box.top);
        right = Math.max(right, box.right);
        bottom = Math.max(bottom, box.bottom);
      }
    }

    const m = this.ctx.entities.getWorldTransform?.(node.id);
    const pTopLeft = m ? applyMatrix(m, left, top) : { x: node.x + left, y: node.y + top };
    const pBottomRight = m ? applyMatrix(m, right, bottom) : { x: node.x + right, y: node.y + bottom };
    const width = right - left;
    const height = bottom - top;

    const selectionColor = this.ctx.session.theme?.selectionStroke ?? '$accent';
    const isTransformed = m && (m.b !== 0 || m.c !== 0);

    const primitives: CanvasPrimitive[] = [];

    if (isTransformed) {
      const pTopRight = applyMatrix(m, right, top);
      const pBottomLeft = applyMatrix(m, left, bottom);
      primitives.push({
        kind: 'polygon',
        points: [
          pTopLeft.x,
          pTopLeft.y,
          pTopRight.x,
          pTopRight.y,
          pBottomRight.x,
          pBottomRight.y,
          pBottomLeft.x,
          pBottomLeft.y
        ],
        fill: selectionColor,
        fillOpacity: 0.12,
        stroke: selectionColor,
        strokeWidth: 2
      });
    } else {
      primitives.push(
        // 半透明选区高亮底色
        {
          kind: 'rect',
          x: pTopLeft.x,
          y: pTopLeft.y,
          width,
          height,
          fill: selectionColor,
          fillOpacity: 0.12
        },
        // 选区 2px 描边外框
        {
          kind: 'rect',
          x: pTopLeft.x,
          y: pTopLeft.y,
          width,
          height,
          stroke: selectionColor,
          strokeWidth: 2
        }
      );
    }

    this.ctx.host.overlay.setPrimitives(OVERLAY_SESSION, primitives, { transient: true });
  }

  /** 清空当前选中范围内的所有单元格文本 */
  private clearSelectedCellsContent(node: NodeEntity): void {
    if (!this.activeSelection) return;
    const { startRow, startCol, endRow, endCol } = this.activeSelection;
    const minR = Math.min(startRow, endRow);
    const maxR = Math.max(startRow, endRow);
    const minC = Math.min(startCol, endCol);
    const maxC = Math.max(startCol, endCol);

    const targetSlots = new Set<string>();
    const table = node.table!;
    const merges = buildMergeLookup(table.merges, table.rowCount, table.columnCount);
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const key = cellKey(r, c);
        if (!merges?.byKey.has(key) || merges.masterKeys.has(key)) targetSlots.add(tableCellSlot(r, c));
      }
    }

    const nextBlocks = (node.textBlocks ?? []).map((b) => {
      if (b.slot && targetSlots.has(b.slot)) {
        return { ...b, runs: [{ text: '' }] };
      }
      return b;
    });

    const updatedNode: NodeEntity = {
      ...node,
      textBlocks: nextBlocks
    };

    this.ctx.document.commit({
      label: '清空单元格内容',
      patches: [{ op: 'set', path: ['content', 'nodes', node.id], value: updatedNode }]
    });
  }
}

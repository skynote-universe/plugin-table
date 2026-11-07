/**
 * @file table-node.ts
 * @description 表格图元类型定义 (NodeTypeDefinition)：声明式图元装配、动态尺寸与统一文本槽位
 */

import {
  createTextBlockPrimitive,
  parseCssColor,
  resolveThemeColor,
  resolveNodeStyle,
  resolveTextBlockStyle,
  type CanvasPatch,
  type CanvasPrimitive,
  type NodeComposeContext,
  type NodeCreateContent,
  type NodeEntity,
  type NodeResizeAxes,
  type NodeResizeRequest,
  type NodeStyle,
  type NodeTextStyle,
  type NodeTypeDefinition,
  type Point,
  type RectBounds,
  type RgbaColor,
  type TextBlock,
  type TextBlockMetrics
} from '@skynote/core';
import { computeGridLinePrimitives, computeTableTracks, buildMergeLookup, getCellBox } from './layout';
import { isTableThemeColor, tableTextColor, tableThemeRegistry, withTableThemeColor } from './themes';
import { getTableGridStyle, TABLE_GRID_STYLES } from './grid-styles';
import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  DEFAULT_TABLE_COLUMNS,
  DEFAULT_TABLE_ROWS,
  MAX_TABLE_CELLS,
  MIN_COLUMN_WIDTH,
  MIN_ROW_HEIGHT,
  TABLE_NODE_TYPE,
  cellKey,
  parseTableCellSlot,
  parseCellKey,
  tableCellSlot,
  type TableCreateOptions,
  type TableNodeFields
} from './types';

const CELL_PADDING_X = 8;
const CELL_PADDING_Y = 6;

export class TableNodeType implements NodeTypeDefinition {
  static readonly TYPE = TABLE_NODE_TYPE;
  private readonly layouts = new WeakMap<
    TableNodeFields,
    {
      tracks: ReturnType<typeof computeTableTracks>;
      mergeLookup: ReturnType<typeof buildMergeLookup>;
    }
  >();

  /** 同一不可变表格版本的各单元格共用标尺，避免逐块测量时反复重建。 */
  private layout(table: TableNodeFields) {
    let layout = this.layouts.get(table);
    if (!layout) {
      layout = {
        tracks: computeTableTracks(table.rowCount, table.columnCount, table.rows, table.columns),
        mergeLookup: buildMergeLookup(table.merges, table.rowCount, table.columnCount)
      };
      this.layouts.set(table, layout);
    }
    return layout;
  }

  readonly type = TableNodeType.TYPE;
  readonly label = '表格';
  readonly defaultData = {};
  readonly defaultAspectLocked = false;
  readonly quickConnect = false;
  readonly tabNavigatesTextBlocks = true;
  readonly resize: NodeResizeAxes = 'none';
  readonly layoutTriggerFields = ['table'] as const;
  readonly defaultStyle: NodeStyle = {
    strokeWidth: 1
  };

  validate(node: Readonly<NodeEntity>): string | null {
    const table = node.table;
    if (
      table?.themeColor !== undefined &&
      (typeof table.themeColor !== 'string' || !isTableThemeColor(table.themeColor))
    )
      return '表格主题色无效';
    if (
      !table ||
      !Number.isSafeInteger(table.rowCount) ||
      !Number.isSafeInteger(table.columnCount) ||
      table.rowCount < 1 ||
      table.columnCount < 1 ||
      table.rowCount * table.columnCount > MAX_TABLE_CELLS
    ) {
      return '表格行列数无效或超出容量';
    }
    const slots = new Set<string>();
    for (const block of node.textBlocks ?? []) {
      const pos = block.slot && parseTableCellSlot(block.slot);
      if (
        !pos ||
        pos.row >= table.rowCount ||
        pos.col >= table.columnCount ||
        block.slot !== tableCellSlot(pos.row, pos.col) ||
        block.id !== block.slot ||
        slots.has(block.id)
      ) {
        return '表格单元格文字槽位无效';
      }
      slots.add(block.id);
    }
    if (slots.size !== table.rowCount * table.columnCount) return '表格单元格文字槽位不完整';
    if (table.merges !== undefined && !Array.isArray(table.merges)) return '表格合并范围无效';
    if (table.gridStyle !== undefined && !TABLE_GRID_STYLES.some((grid) => grid.id === table.gridStyle))
      return '表格网格样式无效';
    const merged = new Set<string>();
    for (const range of table.merges ?? []) {
      if (
        !range ||
        ![range.startRow, range.endRow, range.startCol, range.endCol].every(Number.isSafeInteger) ||
        range.startRow < 0 ||
        range.startCol < 0 ||
        range.endRow >= table.rowCount ||
        range.endCol >= table.columnCount ||
        range.startRow > range.endRow ||
        range.startCol > range.endCol
      )
        return '表格合并范围无效';
      for (let row = range.startRow; row <= range.endRow; row++) {
        for (let col = range.startCol; col <= range.endCol; col++) {
          const key = cellKey(row, col);
          if (merged.has(key)) return '表格合并范围重叠';
          merged.add(key);
        }
      }
    }
    if (
      table.rows !== undefined &&
      (!Array.isArray(table.rows) ||
        table.rows.length > table.rowCount ||
        table.rows.some(
          (row) =>
            !row ||
            (row.height !== undefined && (!Number.isFinite(row.height) || row.height < 0)) ||
            (row.minHeight !== undefined && (!Number.isFinite(row.minHeight) || row.minHeight < 0))
        ))
    )
      return '表格行高无效';
    if (
      table.columns !== undefined &&
      (!Array.isArray(table.columns) ||
        table.columns.length > table.columnCount ||
        table.columns.some(
          (col) => !col || (col.width !== undefined && (!Number.isFinite(col.width) || col.width < 0))
        ))
    )
      return '表格列宽无效';
    if (
      table.cellMeta !== undefined &&
      (!table.cellMeta ||
        typeof table.cellMeta !== 'object' ||
        Array.isArray(table.cellMeta) ||
        Object.keys(table.cellMeta).some((key) => {
          const pos = parseCellKey(key);
          return !pos || key !== cellKey(pos.row, pos.col) || pos.row >= table.rowCount || pos.col >= table.columnCount;
        }))
    )
      return '表格单元格属性坐标无效';
    return null;
  }

  /** 新建表格节点：初始化行列标尺并为每个单元格生成独立的 TextBlock */
  createContent(options: TableCreateOptions = {}): NodeCreateContent {
    const rowCount = Number.isSafeInteger(options.rowCount)
      ? Math.max(1, Math.min(MAX_TABLE_CELLS, options.rowCount!))
      : DEFAULT_TABLE_ROWS;
    const columnCount = Number.isSafeInteger(options.columnCount)
      ? Math.max(1, Math.min(Math.floor(MAX_TABLE_CELLS / rowCount), options.columnCount!))
      : Math.min(DEFAULT_TABLE_COLUMNS, Math.floor(MAX_TABLE_CELLS / rowCount));
    const defaultRowHeight = options.rowHeight ?? DEFAULT_ROW_HEIGHT;
    const defaultColWidth = options.columnWidth ?? DEFAULT_COLUMN_WIDTH;

    const tracks = computeTableTracks(rowCount, columnCount, undefined, undefined, defaultRowHeight, defaultColWidth);
    const headerRow = options.headerRow ?? true;
    const headerColumn = options.headerColumn ?? false;

    const textBlocks: NodeCreateContent['textBlocks'] = [];
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < columnCount; c++) {
        const slot = tableCellSlot(r, c);
        const isHeader = r === 0 && headerRow;
        const text =
          isHeader && options.headers?.[c] !== undefined
            ? options.headers[c]
            : options.cells?.[r]?.[c] !== undefined
              ? options.cells[r][c]
              : isHeader
                ? `列 ${c + 1}`
                : '';

        textBlocks.push({
          id: slot,
          slot,
          runs: [{ text }],
          style: {
            fontSize: 13,
            fontWeight: isHeader ? 600 : 400,
            textAlign: isHeader ? 'center' : 'left'
          }
        });
      }
    }

    const table: TableNodeFields = {
      rowCount,
      columnCount,
      headerRow,
      headerColumn,
      themeId: options.themeId,
      themeColor: options.themeColor,
      gridStyle: options.gridStyle,
      bandedRows: options.bandedRows,
      totalRow: options.totalRow,
      outerBorder: options.outerBorder,
      ...(options.rowHeight !== undefined
        ? {
            rows: Array.from({ length: rowCount }, (_, r) => ({
              height: tracks.rowStarts[r + 1] - tracks.rowStarts[r]
            }))
          }
        : {}),
      ...(options.columnWidth !== undefined
        ? {
            columns: Array.from({ length: columnCount }, (_, c) => ({
              width: tracks.colStarts[c + 1] - tracks.colStarts[c]
            }))
          }
        : {})
    };

    return {
      width: tracks.totalWidth,
      height: tracks.totalHeight,
      style: { ...this.defaultStyle },
      table,
      textBlocks
    };
  }

  supportsCornerRadius(): boolean {
    return false;
  }

  extent(node: NodeEntity): RectBounds {
    return {
      left: 0,
      top: 0,
      right: node.width,
      bottom: node.height
    };
  }

  /** 控件由覆盖层独立命中，文档实体保持内容几何。 */
  hitTest(node: NodeEntity, point: Point): boolean {
    return point.x >= 0 && point.x <= node.width && point.y >= 0 && point.y <= node.height;
  }

  /**
   * 整体拉伸表格尺寸时按比例等比缩放各个行列的基准尺寸
   */
  applyResize(node: NodeEntity, request: NodeResizeRequest): Partial<NodeEntity> {
    const currentTable = node.table;
    const currentW = Math.max(1, node.width);
    const currentH = Math.max(1, node.height);
    const targetW = Math.max(MIN_COLUMN_WIDTH * (currentTable?.columnCount ?? 1), Math.round(request.width));
    const targetH = Math.max(MIN_ROW_HEIGHT * (currentTable?.rowCount ?? 1), Math.round(request.height));

    if (!currentTable) {
      return { width: targetW, height: targetH };
    }

    const scaleX = targetW / currentW;
    const scaleY = targetH / currentH;

    const tracks = computeTableTracks(
      currentTable.rowCount,
      currentTable.columnCount,
      currentTable.rows,
      currentTable.columns
    );

    const nextRows = Array.from({ length: currentTable.rowCount }, (_, r) => {
      const origH = tracks.rowStarts[r + 1] - tracks.rowStarts[r];
      const nextH = Math.max(MIN_ROW_HEIGHT, Math.round(origH * scaleY));
      return { height: nextH, minHeight: nextH };
    });

    const nextCols = Array.from({ length: currentTable.columnCount }, (_, c) => {
      const origW = tracks.colStarts[c + 1] - tracks.colStarts[c];
      return { width: Math.max(MIN_COLUMN_WIDTH, Math.round(origW * scaleX)) };
    });

    const recalculated = computeTableTracks(currentTable.rowCount, currentTable.columnCount, nextRows, nextCols);

    return {
      width: recalculated.totalWidth,
      height: recalculated.totalHeight,
      table: {
        ...currentTable,
        rows: nextRows,
        columns: nextCols
      }
    };
  }

  /**
   * 为单个单元格文本块提供折行测量宽度（单元格宽度减去左右内边距）
   */
  measureBlockWidth(node: NodeEntity, block: Readonly<TextBlock>): number | undefined {
    if (!block.slot) return undefined;
    const cellPos = parseTableCellSlot(block.slot);
    if (!cellPos) return undefined;
    const table = node.table;
    if (!table || cellPos.row >= table.rowCount || cellPos.col >= table.columnCount) return undefined;

    const { tracks, mergeLookup } = this.layout(table);
    const box = getCellBox(cellPos.row, cellPos.col, tracks, mergeLookup);
    if (box.isCovered) return undefined;
    return Math.max(0, box.width - CELL_PADDING_X * 2);
  }

  /**
   * 根据单元格文本排版测量结果自动撑开或回缩行高，并同步派生更新 table.rows 与整表高度
   */
  computeBounds(
    node: NodeEntity,
    textMetrics: ReadonlyMap<string, TextBlockMetrics>
  ): { width: number; height: number; patches?: readonly CanvasPatch[] } {
    const table = node.table;
    if (!table) {
      return { width: node.width, height: node.height };
    }

    const { tracks, mergeLookup } = this.layout(table);

    const nextRowHeights: number[] = Array.from({ length: table.rowCount }, (_, r) => {
      const rowMeta = table.rows?.[r];
      return Math.max(MIN_ROW_HEIGHT, rowMeta?.minHeight ?? DEFAULT_ROW_HEIGHT);
    });

    // 1. 先按单行非合并单元格所需高度撑开对应行 (默认 'ellipsis' 不撑高，仅对 overflow === 'auto-height' 的单元格生效)
    for (let r = 0; r < table.rowCount; r++) {
      for (let c = 0; c < table.columnCount; c++) {
        const cellOverflow = table.cellMeta?.[cellKey(r, c)]?.overflow ?? table.cellOverflow ?? 'ellipsis';
        if (cellOverflow === 'ellipsis') continue;
        const box = getCellBox(r, c, tracks, mergeLookup);
        const rowSpan = box.mergeRange ? box.mergeRange.endRow - box.mergeRange.startRow + 1 : 1;
        if (box.isCovered || rowSpan > 1) continue;
        const m = textMetrics.get(tableCellSlot(r, c));
        if (!m || m.height <= 0) continue;
        const neededH = Math.ceil(m.height + CELL_PADDING_Y * 2);
        if (neededH > nextRowHeights[r]) {
          nextRowHeights[r] = neededH;
        }
      }
    }

    // 2. 再处理跨行合并单元格：若跨行总高不足以容纳内容，将差额补在合并块末行
    for (let r = 0; r < table.rowCount; r++) {
      for (let c = 0; c < table.columnCount; c++) {
        const cellOverflow = table.cellMeta?.[cellKey(r, c)]?.overflow ?? table.cellOverflow ?? 'ellipsis';
        if (cellOverflow === 'ellipsis') continue;
        const box = getCellBox(r, c, tracks, mergeLookup);
        const rowSpan = box.mergeRange ? box.mergeRange.endRow - box.mergeRange.startRow + 1 : 1;
        if (box.isCovered || rowSpan <= 1) continue;
        const m = textMetrics.get(tableCellSlot(r, c));
        if (!m || m.height <= 0) continue;
        const neededSpanH = Math.ceil(m.height + CELL_PADDING_Y * 2);
        let currentSpanH = 0;
        for (let k = r; k < r + rowSpan && k < table.rowCount; k++) {
          currentSpanH += nextRowHeights[k];
        }
        if (neededSpanH > currentSpanH) {
          const lastSpanRow = Math.min(table.rowCount - 1, r + rowSpan - 1);
          nextRowHeights[lastSpanRow] += neededSpanH - currentSpanH;
        }
      }
    }

    let rowsChanged = false;
    for (let r = 0; r < table.rowCount; r++) {
      const currentH = tracks.rowStarts[r + 1] - tracks.rowStarts[r];
      if (Math.abs(nextRowHeights[r] - currentH) > 0.5) {
        rowsChanged = true;
        break;
      }
    }

    if (!rowsChanged) {
      return { width: tracks.totalWidth, height: tracks.totalHeight };
    }

    const nextRows = Array.from({ length: table.rowCount }, (_, r) => ({
      ...(table.rows?.[r] ?? {}),
      height: nextRowHeights[r]
    }));
    const nextTracks = computeTableTracks(table.rowCount, table.columnCount, nextRows, table.columns);

    return {
      width: nextTracks.totalWidth,
      height: nextTracks.totalHeight,
      patches: [
        {
          op: 'set',
          path: ['content', 'nodes', node.id, 'table', 'rows'],
          value: nextRows
        }
      ]
    };
  }

  /**
   * 声明式跨引擎中间表示 (IR)：
   * 纯函数，按顺序输出背景外框、斑马纹、表头底色、汇总行底色、自定义单元格背景色、分割线网格以及各单元格文本
   */
  compose(node: NodeEntity, context: NodeComposeContext): CanvasPrimitive[] {
    const table: TableNodeFields = node.table ?? {
      rowCount: DEFAULT_TABLE_ROWS,
      columnCount: DEFAULT_TABLE_COLUMNS,
      headerRow: true
    };

    const theme = withTableThemeColor(tableThemeRegistry.getTheme(table.themeId), table.themeColor, context.theme);
    const grid = getTableGridStyle(table.gridStyle);
    const resolvedStyle = resolveNodeStyle(node, this);
    const { tracks, mergeLookup } = this.layout(table);

    // 主题默认值作为底层基线，用户手动设置具有绝对最高优先级
    const isHeaderRow = table.headerRow ?? theme.defaultHeaderRow ?? true;
    const isHeaderCol = table.headerColumn ?? theme.defaultHeaderColumn ?? false;
    const isBandedRows = table.bandedRows ?? theme.defaultBandedRows ?? false;
    const isTotalRow = table.totalRow ?? theme.defaultTotalRow ?? false;

    const baseFill =
      typeof node.style?.fill === 'string' ? node.style.fill : (theme.bodyFill ?? context.theme.background);
    const headerColFill =
      theme.headerColFill ??
      (theme.headerFill && theme.headerFill !== 'transparent' ? theme.headerFill : context.theme.nodeFill);
    const primitives: CanvasPrimitive[] = [];

    // 1. 表格主底色矩形 (纯直角单元格容器，无圆角)
    primitives.push({
      kind: 'rect',
      x: 0,
      y: 0,
      width: node.width,
      height: node.height,
      fill: baseFill,
      fillOpacity: node.style?.fillOpacity
    });

    // 2. 隔行斑马纹背景 (若启用)
    if (isBandedRows && table.rowCount > 1) {
      const startR = isHeaderRow ? 1 : 0;
      const endR = isTotalRow ? table.rowCount - 2 : table.rowCount - 1;
      const bandedFill = theme.bandedFill ?? context.theme.nodeFill;
      const bandedOpacity = theme.bandedFillOpacity ?? 0.06;

      for (let r = startR; r <= endR; r++) {
        if (r % 2 === 1) {
          const rowY = tracks.rowStarts[r];
          const rowH = tracks.rowStarts[r + 1] - rowY;
          primitives.push({
            kind: 'rect',
            x: 0,
            y: rowY,
            width: node.width,
            height: rowH,
            fill: bandedFill,
            fillOpacity: bandedOpacity
          });
        }
      }
    }

    // 3. 表头行背景高亮 (纯直角，取消圆角)
    if (isHeaderRow && table.rowCount > 0 && theme.headerFill && theme.headerFill !== 'transparent') {
      const headerH = tracks.rowStarts[1] - tracks.rowStarts[0];
      primitives.push({
        kind: 'rect',
        x: 0,
        y: 0,
        width: node.width,
        height: headerH,
        fill: theme.headerFill === '$nodeFill' ? context.theme.nodeFill : theme.headerFill
      });
    }

    // 4. 首列背景高亮 (若启用，纯直角)
    if (isHeaderCol && table.columnCount > 0) {
      const firstColW = tracks.colStarts[1] - tracks.colStarts[0];
      primitives.push({
        kind: 'rect',
        x: 0,
        y: 0,
        width: firstColW,
        height: node.height,
        fill: headerColFill,
        fillOpacity: theme.bandedFillOpacity ?? 0.08
      });
    }

    // 5. 汇总行底色高亮 (若启用，纯直角)
    if (isTotalRow && table.rowCount > 1) {
      const lastR = table.rowCount - 1;
      const totalY = tracks.rowStarts[lastR];
      const totalH = tracks.rowStarts[lastR + 1] - totalY;
      primitives.push({
        kind: 'rect',
        x: 0,
        y: totalY,
        width: node.width,
        height: totalH,
        fill: theme.totalFill ?? context.theme.nodeFill,
        fillOpacity: 0.12
      });
    }

    // 6. 自定义单元格背景填充 (纯直角矩形，彻底取消圆角)
    if (table.cellMeta) {
      for (let r = 0; r < table.rowCount; r++) {
        for (let c = 0; c < table.columnCount; c++) {
          const meta = table.cellMeta[cellKey(r, c)];
          if (!meta?.fill) continue;
          const box = getCellBox(r, c, tracks, mergeLookup);
          if (box.isCovered) continue;

          // 若用户显式设置透明/无底色，绘制表格基础底色以覆盖下层的表头/斑马纹主题底色
          const cellFill = meta.fill === 'transparent' || meta.fill === 'none' ? baseFill : meta.fill;

          primitives.push({
            kind: 'rect',
            x: box.left,
            y: box.top,
            width: box.width,
            height: box.height,
            fill: cellFill
          });
        }
      }
    }

    const hasCustomBorders = Boolean(
      (table.cellMeta && Object.values(table.cellMeta).some((m) => Boolean(m.borders))) ||
      table.outerBorders ||
      table.innerBorders ||
      table.innerBorder !== undefined
    );
    const hasUserStroke = node.style?.stroke !== undefined;
    const hasUserStrokeWidth = node.style?.strokeWidth !== undefined;

    // 用户在节点级别显式指定的描边属性具有最高优先级，覆盖主题默认描边
    const defaultStroke = hasUserStroke
      ? node.style!.stroke!
      : (theme.strokeColor ?? resolvedStyle.stroke ?? context.theme.nodeStroke);
    const defaultStrokeW = hasUserStrokeWidth
      ? node.style!.strokeWidth!
      : (grid.strokeWidth ?? resolvedStyle.strokeWidth ?? 1);

    const isOuterBorder = table.outerBorder ?? grid.defaultOuterBorder;
    const outerStroke = hasUserStroke
      ? node.style!.stroke!
      : (table.outerBorders?.color ??
        grid.outerBorder?.color ??
        theme.strokeColor ??
        resolvedStyle.stroke ??
        context.theme.nodeStroke);
    const outerStrokeW = hasUserStrokeWidth
      ? node.style!.strokeWidth!
      : (table.outerBorders?.width ?? grid.outerBorder?.width ?? grid.strokeWidth ?? resolvedStyle.strokeWidth ?? 1);

    // 7. 表格外边框矩形 (无自定义分边/内框配置时作为整块外框绘制，确保默认主题如经典网格的外边框完整闭合)
    if (
      isOuterBorder &&
      !grid.defaultOuterSides &&
      !hasCustomBorders &&
      outerStrokeW > 0 &&
      outerStroke !== 'transparent'
    ) {
      primitives.push({
        kind: 'rect',
        x: 0,
        y: 0,
        width: node.width,
        height: node.height,
        stroke: outerStroke,
        strokeWidth: outerStrokeW
      });
    }

    // 8. 内部网格线、学术线与单元格自定义边框 (置于单元格底色图元及表格外边框之上)
    primitives.push(
      ...computeGridLinePrimitives(
        { ...table, totalRow: isTotalRow },
        tracks,
        mergeLookup,
        defaultStroke,
        defaultStrokeW,
        grid
      )
    );

    // 只缓存本次绘制的解析颜色，逐格按绘制顺序叠色，避免扫描背景图元产生平方开销。
    const parsedColors = new Map<string, RgbaColor>();
    const textColors = new Map<string, string>();
    const paint = (background: RgbaColor, color: string | undefined, opacity = 1): RgbaColor => {
      if (!color || color === 'transparent' || color === 'none') return background;
      let fill = parsedColors.get(color);
      if (!fill) {
        const parsed = parseCssColor(resolveThemeColor(color, context.theme)!);
        if (!parsed) return background;
        fill = parsed;
        parsedColors.set(color, fill);
      }
      const alpha = Math.max(0, Math.min(1, fill.a * opacity));
      return {
        r: fill.r * alpha + background.r * (1 - alpha),
        g: fill.g * alpha + background.g * (1 - alpha),
        b: fill.b * alpha + background.b * (1 - alpha),
        a: 1
      };
    };
    const baseBackground = paint(parseCssColor(context.theme.background)!, baseFill, node.style?.fillOpacity ?? 1);

    // 9. 各单元格富文本图元
    const textBlocks = node.textBlocks ?? [];
    for (const block of textBlocks) {
      if (!block.slot) continue;
      const cellPos = parseTableCellSlot(block.slot);
      if (!cellPos) continue;
      const { row, col } = cellPos;
      if (row >= table.rowCount || col >= table.columnCount) continue;

      const box = getCellBox(row, col, tracks, mergeLookup);
      // 被合并的从属单元格不独立渲染文字
      if (box.isCovered) continue;

      const cellMeta = table.cellMeta?.[cellKey(row, col)];
      const isHeaderBlock = isHeaderRow && row === 0;
      const isTotalBlock = isTotalRow && row === table.rowCount - 1;
      const isHeaderColBlock = isHeaderCol && col === 0;

      const defaultAlign = isHeaderBlock ? (theme.headerAlign ?? 'center') : (theme.bodyAlign ?? 'left');
      const defaultVAlign = isHeaderBlock
        ? (theme.headerVerticalAlign ?? 'middle')
        : (theme.bodyVerticalAlign ?? 'middle');

      const blockStyle = resolveTextBlockStyle(node, block, this);

      let textColor = blockStyle.color;
      if (isHeaderBlock && theme.headerText) {
        textColor = theme.headerText;
      } else if (isTotalBlock && theme.totalText) {
        textColor = theme.totalText;
      } else if (isHeaderColBlock && theme.headerColText) {
        textColor = theme.headerColText;
      }

      if (block.style?.color !== undefined || node.textStyle?.color !== undefined) {
        textColor = blockStyle.color;
      } else if (
        table.themeColor !== undefined ||
        cellMeta?.fill !== undefined ||
        (!isHeaderBlock && !isTotalBlock && !isHeaderColBlock) ||
        !textColor
      ) {
        let background = baseBackground;
        const bandedStart = isHeaderRow ? 1 : 0;
        const bandedEnd = isTotalRow ? table.rowCount - 2 : table.rowCount - 1;
        if (isBandedRows && row >= bandedStart && row <= bandedEnd && row % 2 === 1)
          background = paint(background, theme.bandedFill ?? context.theme.nodeFill, theme.bandedFillOpacity ?? 0.06);
        if (isHeaderBlock) background = paint(background, theme.headerFill);
        if (isHeaderColBlock) background = paint(background, headerColFill, theme.bandedFillOpacity ?? 0.08);
        if (isTotalBlock && table.rowCount > 1)
          background = paint(background, theme.totalFill ?? context.theme.nodeFill, 0.12);
        if (cellMeta?.fill !== undefined)
          background = paint(
            background,
            cellMeta.fill === 'transparent' || cellMeta.fill === 'none' ? baseFill : cellMeta.fill
          );
        const backgroundKey = [background.r, background.g, background.b].join(':');
        textColor = textColors.get(backgroundKey);
        if (!textColor) {
          textColor = tableTextColor(background, context.theme);
          textColors.set(backgroundKey, textColor);
        }
      }

      const cellOverflow = cellMeta?.overflow ?? table.cellOverflow ?? 'ellipsis';
      const effectiveStyle: NodeTextStyle = {
        ...blockStyle,
        textAlign: block.style?.textAlign ?? cellMeta?.align ?? blockStyle.textAlign ?? defaultAlign,
        verticalAlign:
          block.style?.verticalAlign ?? cellMeta?.verticalAlign ?? blockStyle.verticalAlign ?? defaultVAlign,
        textOverflow: cellOverflow === 'ellipsis' ? 'ellipsis' : 'clip',
        color: textColor
      };

      const innerW = Math.max(0, box.width - CELL_PADDING_X * 2);
      const innerH = Math.max(0, box.height - CELL_PADDING_Y * 2);

      const primitive = createTextBlockPrimitive(block, effectiveStyle, {
        x: box.left + CELL_PADDING_X,
        y: box.top + CELL_PADDING_Y,
        width: innerW,
        height: innerH
      });
      primitives.push(primitive);
    }

    return primitives;
  }
}

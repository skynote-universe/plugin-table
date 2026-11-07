import { describe, expect, it } from 'vitest';
import {
  computeTableTracks,
  findCellAtLocalPoint,
  buildMergeLookup,
  getCellBox,
  computeGridLinePrimitives
} from '../src/layout';
import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_ROW_HEIGHT,
  type TableNodeFields
} from '../src/types';

describe('Table Layout & Prefix Sum Tracks', () => {
  it('正确计算默认行列标尺与总尺寸', () => {
    const tracks = computeTableTracks(3, 4);
    expect(tracks.rowStarts).toEqual([0, DEFAULT_ROW_HEIGHT, DEFAULT_ROW_HEIGHT * 2, DEFAULT_ROW_HEIGHT * 3]);
    expect(tracks.colStarts).toEqual([
      0,
      DEFAULT_COLUMN_WIDTH,
      DEFAULT_COLUMN_WIDTH * 2,
      DEFAULT_COLUMN_WIDTH * 3,
      DEFAULT_COLUMN_WIDTH * 4
    ]);
    expect(tracks.totalWidth).toBe(DEFAULT_COLUMN_WIDTH * 4);
    expect(tracks.totalHeight).toBe(DEFAULT_ROW_HEIGHT * 3);
  });

  it('支持稀疏自定义行高与列宽，并遵守最小尺寸约束', () => {
    const tracks = computeTableTracks(
      3,
      3,
      [{ height: 50 }, {}, { height: 10 }], // 第3行 10px 触碰 MIN_ROW_HEIGHT
      [{}, { width: 200 }, { width: 20 }] // 第3列 20px 触碰 MIN_COLUMN_WIDTH
    );

    expect(tracks.rowStarts[1] - tracks.rowStarts[0]).toBe(50);
    expect(tracks.rowStarts[2] - tracks.rowStarts[1]).toBe(DEFAULT_ROW_HEIGHT);
    expect(tracks.rowStarts[3] - tracks.rowStarts[2]).toBe(MIN_ROW_HEIGHT);

    expect(tracks.colStarts[1] - tracks.colStarts[0]).toBe(DEFAULT_COLUMN_WIDTH);
    expect(tracks.colStarts[2] - tracks.colStarts[1]).toBe(200);
    expect(tracks.colStarts[3] - tracks.colStarts[2]).toBe(MIN_COLUMN_WIDTH);
  });

  it('二分查找准确反查局部坐标落入的单元格', () => {
    const tracks = computeTableTracks(3, 3);
    // (10, 10) 属于第 0 行第 0 列
    expect(findCellAtLocalPoint(tracks, 10, 10)).toEqual({ row: 0, col: 0 });
    // (130, 40) 属于第 1 行第 1 列
    expect(findCellAtLocalPoint(tracks, 130, 40)).toEqual({ row: 1, col: 1 });
    // 超出范围返回 null
    expect(findCellAtLocalPoint(tracks, -5, 10)).toBeNull();
    expect(findCellAtLocalPoint(tracks, 1000, 10)).toBeNull();
    expect(findCellAtLocalPoint(tracks, 10, 1000)).toBeNull();
  });

  it('合并单元格正确计算跨越范围与主从状态', () => {
    const tracks = computeTableTracks(4, 4);
    // 合并 [0, 0] 到 [1, 1] (2x2)
    const mergeLookup = buildMergeLookup([{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }], 4, 4);

    // 主单元格 [0, 0]
    const masterBox = getCellBox(0, 0, tracks, mergeLookup);
    expect(masterBox.isMaster).toBe(true);
    expect(masterBox.isCovered).toBe(false);
    expect(masterBox.width).toBe(DEFAULT_COLUMN_WIDTH * 2);
    expect(masterBox.height).toBe(DEFAULT_ROW_HEIGHT * 2);

    // 从属被覆盖单元格 [0, 1]、[1, 0]、[1, 1]
    const slaveBox = getCellBox(0, 1, tracks, mergeLookup);
    expect(slaveBox.isMaster).toBe(false);
    expect(slaveBox.isCovered).toBe(true);

    // 非合并单元格 [2, 2]
    const normalBox = getCellBox(2, 2, tracks, mergeLookup);
    expect(normalBox.isMaster).toBe(true);
    expect(normalBox.isCovered).toBe(false);
    expect(normalBox.width).toBe(DEFAULT_COLUMN_WIDTH);
    expect(normalBox.height).toBe(DEFAULT_ROW_HEIGHT);
  });

  it('分割线生成在合并单元格内部自动消隐边线', () => {
    const table: TableNodeFields = {
      rowCount: 3,
      columnCount: 3,
      merges: [{ startRow: 0, startCol: 0, endRow: 1, endCol: 1 }]
    };
    const tracks = computeTableTracks(3, 3);
    const mergeLookup = buildMergeLookup(table.merges, 3, 3);
    const primitives = computeGridLinePrimitives(table, tracks, mergeLookup, '#E2E8F0', 1);

    // 检查第 1 行与第 1 列的交汇处是否存在被消隐的内部边线
    // [0, 0] 到 [1, 1] 内部横线位于 y = tracks.rowStarts[1] 处，在 c=0 与 c=1 处不应生成
    const internalHorizontal = primitives.find(
      (p) =>
        p.kind === 'line' &&
        p.points[1] === tracks.rowStarts[1] &&
        p.points[0] === 0 &&
        p.points[2] === DEFAULT_COLUMN_WIDTH
    );
    expect(internalHorizontal).toBeUndefined();
  });

  it('分割线生成正确支持单元格独立边框与显式隐藏', () => {
    const table: TableNodeFields = {
      rowCount: 2,
      columnCount: 2,
      cellMeta: {
        '0,0': {
          borders: {
            bottom: { color: '#FF0000', width: 3, style: 'dashed' }
          }
        },
        '1,0': {
          borders: {
            right: { width: 0 }
          }
        }
      }
    };
    const tracks = computeTableTracks(2, 2);
    const primitives = computeGridLinePrimitives(table, tracks, null, '#E2E8F0', 1);

    // [0, 0] bottom 边框为 #FF0000 且 3px dashed
    const customLine = primitives.find(
      (p) => p.kind === 'line' && p.points[1] === tracks.rowStarts[1] && p.points[0] === 0
    );
    expect(customLine).toBeDefined();
    expect(customLine?.kind).toBe('line');
    if (customLine?.kind === 'line') {
      expect(customLine.stroke).toBe('#FF0000');
      expect(customLine.strokeWidth).toBe(3);
      expect(customLine.strokeDashArray).toEqual([4, 4]);
    }

    // [1, 0] right 边框 width: 0，该垂直线段 (x=120, y: 36..72) 被跳过不绘制
    const hiddenLine = primitives.find(
      (p) =>
        p.kind === 'line' &&
        p.points[0] === tracks.colStarts[1] &&
        p.points[2] === tracks.colStarts[1] &&
        p.points[1] === tracks.rowStarts[1]
    );
    expect(hiddenLine).toBeUndefined();
  });

  it('斜线表头支持独立颜色、粗细与虚线/双线线型渲染', () => {
    const table: TableNodeFields = {
      rowCount: 2,
      columnCount: 2,
      cellMeta: {
        '0,0': {
          diagonal: {
            direction: 'down',
            color: '#3B82F6',
            width: 2,
            style: 'dashed'
          }
        },
        '0,1': {
          diagonal: {
            direction: 'up',
            color: '#10B981',
            width: 2,
            style: 'double'
          }
        }
      }
    };
    const tracks = computeTableTracks(2, 2);
    const primitives = computeGridLinePrimitives(table, tracks, null, '#E2E8F0', 1);

    // 1. [0,0] down 虚线
    const dashedDiag = primitives.find(
      (p) =>
        p.kind === 'line' &&
        p.points[0] === 0 &&
        p.points[1] === 0 &&
        p.points[2] === tracks.colStarts[1] &&
        p.points[3] === tracks.rowStarts[1]
    );
    expect(dashedDiag).toBeDefined();
    if (dashedDiag?.kind === 'line') {
      expect(dashedDiag.stroke).toBe('#3B82F6');
      expect(dashedDiag.strokeWidth).toBe(2);
      expect(dashedDiag.strokeDashArray).toEqual([4, 4]);
    }

    // 2. [0,1] up 双线 (渲染为双平行斜线段)
    const doubleDiags = primitives.filter((p) => p.kind === 'line' && p.stroke === '#10B981');
    expect(doubleDiags.length).toBe(2);
  });
});

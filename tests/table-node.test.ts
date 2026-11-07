import { describe, expect, it } from 'vitest';
import { deriveCanvasTheme, LIGHT_CANVAS_THEME_SEED, type NodeEntity } from '@skynote/core';
import { TableNodeType } from '../src/table-node';
import { tableThemeRegistry } from '../src/themes';
import { DEFAULT_COLUMN_WIDTH, DEFAULT_ROW_HEIGHT, TABLE_NODE_TYPE, cellKey } from '../src/types';

describe('TableNodeType Definition & Compose IR', () => {
  const nodeType = new TableNodeType();

  it('当 outerBorder 为 false 时，不渲染外边框矩形且不绘制最外圈框线', () => {
    const content = nodeType.createContent({ rowCount: 2, columnCount: 2 });
    const mockNode: NodeEntity = {
      id: 'table-outer-false',
      type: 'node',
      nodeType: TABLE_NODE_TYPE,
      x: 0,
      y: 0,
      width: content.width,
      height: content.height,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      style: { fill: '#FFFFFF' },
      table: {
        ...content.table!,
        themeId: 'plain-grid',
        outerBorder: false,
        cellMeta: {
          [cellKey(0, 0)]: { borders: { top: { width: 2, style: 'solid' } } }
        }
      },
      textBlocks: content.textBlocks
    };

    const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    const primitives = nodeType.compose(mockNode, { theme });

    // 不包含外边框矩形
    const outerRect = primitives.find((p) => p.kind === 'rect' && p.stroke && p.width === content.width);
    expect(outerRect).toBeUndefined();

    // 不包含最外围顶边线 (y: 0)
    const lines = primitives.filter((p) => p.kind === 'line');
    const topLine = lines.find((l) => l.points?.[1] === 0 && l.points?.[3] === 0);
    expect(topLine).toBeUndefined();
  });

  it('具有正确的元类型属性', () => {
    expect(nodeType.type).toBe(TABLE_NODE_TYPE);
    expect(nodeType.label).toBe('表格');
    expect(nodeType.defaultAspectLocked).toBe(false);
    expect(nodeType.quickConnect).toBe(false);
    expect(nodeType.resize).toBe('none');
    expect(nodeType.supportsCornerRadius()).toBe(false);
  });

  it('重复测量共用当前布局，行列或合并范围更新后使用新几何', () => {
    const content = nodeType.createContent({ rowCount: 2, columnCount: 2 });
    const node: NodeEntity = {
      ...content,
      id: 'measure-cache',
      type: 'node',
      nodeType: TABLE_NODE_TYPE,
      x: 0,
      y: 0,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    };
    const block = node.textBlocks![0];
    expect(nodeType.measureBlockWidth(node, block)).toBe(84);
    expect(nodeType.measureBlockWidth(node, block)).toBe(84);
    const resized: NodeEntity = { ...node, table: { ...node.table!, columns: [{ width: 180 }, {}] } };
    expect(nodeType.measureBlockWidth(resized, block)).toBe(164);
    const merged: NodeEntity = {
      ...resized,
      table: { ...resized.table!, merges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }] }
    };
    expect(nodeType.measureBlockWidth(merged, block)).toBe(264);
    expect(nodeType.measureBlockWidth(merged, merged.textBlocks![1])).toBeUndefined();
    expect(nodeType.measureBlockWidth(node, block)).toBe(84);
  });

  it('createContent 准确初始化尺寸与各个单元格的 TextBlock', () => {
    const content = nodeType.createContent({
      rowCount: 2,
      columnCount: 3,
      headers: ['姓名', '年龄', '职业']
    });

    expect(content.width).toBe(DEFAULT_COLUMN_WIDTH * 3);
    expect(content.height).toBe(DEFAULT_ROW_HEIGHT * 2);
    expect(content.textBlocks).toHaveLength(6);

    const firstBlock = content.textBlocks?.[0];
    expect(firstBlock?.slot).toBe('table:cell:0:0');
    expect(firstBlock?.runs[0]?.text).toBe('姓名');

    const secondBlock = content.textBlocks?.[1];
    expect(secondBlock?.slot).toBe('table:cell:0:1');
    expect(secondBlock?.runs[0]?.text).toBe('年龄');
  });

  it('compose 生成规范的 CanvasPrimitive 中间表示', () => {
    const content = nodeType.createContent({
      rowCount: 2,
      columnCount: 2
    });

    const mockNode: NodeEntity = {
      id: 'table-1',
      type: 'node',
      nodeType: TABLE_NODE_TYPE,
      x: 100,
      y: 100,
      width: content.width,
      height: content.height,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      style: { fill: '#FFFFFF', stroke: '#E2E8F0', strokeWidth: 1 },
      table: content.table,
      textBlocks: content.textBlocks
    };

    const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    const primitives = nodeType.compose(mockNode, { theme });
    // 应当包含：1个外框、1个表头底色、2条网格线、4个文本图元
    expect(primitives.length).toBeGreaterThanOrEqual(8);

    // 应当包含顶部拖拽把手及主底色矩形
    const bg = primitives.find((p) => p.kind === 'rect' && p.x === 0 && p.y === 0);
    expect(bg).toBeDefined();
    if (bg && bg.kind === 'rect') {
      expect(bg.width).toBe(content.width);
      expect(bg.height).toBe(content.height);
    }

    const textPrimitives = primitives.filter((p) => p.kind === 'text');
    expect(textPrimitives).toHaveLength(4);
  });

  it('单元格设置底色时，底色图元置于底层，外边框和网格线图元置于顶层，且单元格取消圆角', () => {
    const content = nodeType.createContent({
      rowCount: 3,
      columnCount: 3
    });

    const mockNode: NodeEntity = {
      id: 'table-1',
      type: 'node',
      nodeType: TABLE_NODE_TYPE,
      x: 0,
      y: 0,
      width: content.width,
      height: content.height,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      style: { fill: '#FFFFFF', stroke: '#3B82F6', strokeWidth: 2, radius: 8 },
      table: {
        ...content.table!,
        cellMeta: {
          [cellKey(0, 0)]: { fill: '#FEF08A' },
          [cellKey(1, 1)]: { fill: '#BFDBFE' }
        }
      },
      textBlocks: content.textBlocks
    };

    const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    const primitives = nodeType.compose(mockNode, { theme });

    // 找到角落单元格 (0,0) 的填充图元
    const cornerCellFillIndex = primitives.findIndex((p) => p.kind === 'rect' && p.fill === '#FEF08A');
    expect(cornerCellFillIndex).toBeGreaterThan(-1);
    const cornerCellFill = primitives[cornerCellFillIndex];
    if (cornerCellFill?.kind === 'rect') {
      // 单元格圆角取消，角落单元格也为纯直角
      expect(cornerCellFill.radius).toBeUndefined();
    }

    // 找到中心单元格 (1,1) 的填充图元
    const centerCellFill = primitives.find((p) => p.kind === 'rect' && p.fill === '#BFDBFE');
    expect(centerCellFill).toBeDefined();
    if (centerCellFill?.kind === 'rect') {
      expect(centerCellFill.radius).toBeUndefined();
    }

    // 外边框图元 (stroke: '#3B82F6') 必须位于单元格底色图元之后 (即绘制在上层)
    const outerBorderIndex = primitives.findIndex(
      (p) => p.kind === 'rect' && p.stroke === '#3B82F6' && p.width === content.width && p.height === content.height
    );
    expect(outerBorderIndex).toBeGreaterThan(cornerCellFillIndex);

    // 网格线图元也必须位于单元格底色图元之后 (绘制在上层)
    const gridLineIndex = primitives.findIndex((p) => p.kind === 'line');
    expect(gridLineIndex).toBeGreaterThan(cornerCellFillIndex);
  });

  it('applyResize 按比例拉伸各个行列的尺寸', () => {
    const content = nodeType.createContent({ rowCount: 2, columnCount: 2 });
    const mockNode: NodeEntity = {
      id: 'table-1',
      type: 'node',
      nodeType: TABLE_NODE_TYPE,
      x: 0,
      y: 0,
      width: content.width,
      height: content.height,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      table: content.table
    };

    // 宽度翻倍，高度增加 50%
    const resized = nodeType.applyResize(mockNode, {
      handle: 'se',
      width: content.width * 2,
      height: content.height * 1.5,
      scale: 1
    });

    expect(resized.width).toBe(content.width * 2);
    expect(resized.height).toBe(content.height * 1.5);
    expect(resized.table?.columns?.[0]?.width).toBe(DEFAULT_COLUMN_WIDTH * 2);
    expect(resized.table?.rows?.[0]?.height).toBe(Math.round(DEFAULT_ROW_HEIGHT * 1.5));
  });

  it('hitTest 精准校验外框碰撞', () => {
    const mockNode: NodeEntity = {
      id: 'table-1',
      type: 'node',
      nodeType: TABLE_NODE_TYPE,
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      rotation: 0,
      zIndex: 'a0',
      locked: false
    };

    expect(nodeType.hitTest(mockNode, { x: 50, y: 50 })).toBe(true);
    expect(nodeType.hitTest(mockNode, { x: 50, y: -10 })).toBe(false);
    expect(nodeType.hitTest(mockNode, { x: 50, y: -25 })).toBe(false);
    expect(nodeType.hitTest(mockNode, { x: -10, y: 50 })).toBe(false);
    expect(nodeType.hitTest(mockNode, { x: 250, y: 50 })).toBe(false);
  });

  it('compose 正确装配斑马纹、汇总行与单元格斜线表头', () => {
    const content = nodeType.createContent({ rowCount: 4, columnCount: 3 });
    const mockNode: NodeEntity = {
      id: 'table-themed',
      type: 'node',
      nodeType: TABLE_NODE_TYPE,
      x: 0,
      y: 0,
      width: content.width,
      height: content.height,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      table: {
        ...content.table!,
        bandedRows: true,
        totalRow: true,
        cellMeta: {
          [cellKey(0, 0)]: { diagonal: 'down', align: 'center', verticalAlign: 'middle' }
        }
      },
      textBlocks: content.textBlocks
    };

    const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    const primitives = nodeType.compose(mockNode, { theme });

    // 斜线表头 (kind: line, points: [0, 0, 100, 36])
    const diagonalLine = primitives.find(
      (p) => p.kind === 'line' && p.points?.[0] === 0 && p.points?.[1] === 0 && p.points?.[2] === 100
    );
    expect(diagonalLine).toBeDefined();

    // 单元格文本块对齐方式
    const text00 = primitives.find((p) => p.kind === 'text' && (p as any).id === 'table:cell:0:0');
    expect(text00).toBeDefined();
    if (text00 && text00.kind === 'text') {
      expect(text00.style?.textAlign).toBe('center');
      expect(text00.style?.verticalAlign).toBe('middle');
    }
  });

  it('三线表风格 (three-line) 不渲染四周边框矩形，精确生成顶/底加粗学术线', () => {
    const content = nodeType.createContent({ rowCount: 3, columnCount: 3 });
    const mockNode: NodeEntity = {
      id: 'table-three-line',
      type: 'node',
      nodeType: TABLE_NODE_TYPE,
      x: 0,
      y: 0,
      width: content.width,
      height: content.height,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      style: { stroke: '#000000', strokeWidth: 1.5 },
      table: {
        ...content.table!,
        gridStyle: 'three-line'
      },
      textBlocks: content.textBlocks
    };

    const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    const primitives = nodeType.compose(mockNode, { theme });

    // 不包含外边框矩形
    const outerRect = primitives.find((p) => p.kind === 'rect' && p.stroke && p.width === content.width);
    expect(outerRect).toBeUndefined();

    // 包含顶线 (y: 0) 和底线 (y: content.height)
    const lines = primitives.filter((p) => p.kind === 'line');
    const topLine = lines.find((l) => l.points?.[1] === 0 && l.points?.[3] === 0);
    expect(topLine).toBeDefined();
    const bottomLine = lines.find((l) => l.points?.[1] === content.height && l.points?.[3] === content.height);
    expect(bottomLine).toBeDefined();
  });

  it('用户显式样式优先于主题样式：用户 stroke 覆盖主题 strokeColor，cell fill transparent 覆盖表头色', () => {
    const content = nodeType.createContent({ rowCount: 2, columnCount: 2 });
    const mockNode: NodeEntity = {
      id: 'table-override',
      type: 'node',
      nodeType: TABLE_NODE_TYPE,
      x: 0,
      y: 0,
      width: content.width,
      height: content.height,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      style: { stroke: '#EF4444', strokeWidth: 3 }, // 用户显式红色粗边框
      table: {
        ...content.table!,
        themeId: 'business-blue', // 主题默认是蓝色细边框
        cellMeta: {
          [cellKey(0, 0)]: { fill: 'transparent' } // 用户在表头格显式设置透明/无底色
        }
      },
      textBlocks: content.textBlocks
    };

    const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    const primitives = nodeType.compose(mockNode, { theme });

    // 外边框图元应当使用用户显式设置的红色 #EF4444 和宽度 3，而不是主题的蓝色
    const outerRect = primitives.find((p) => p.kind === 'rect' && p.stroke === '#EF4444' && p.strokeWidth === 3);
    expect(outerRect).toBeDefined();

    // 内部网格线也应当使用用户的红色 #EF4444
    const lines = primitives.filter((p) => p.kind === 'line');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].stroke).toBe('#EF4444');

    // 表头单元格显式 transparent 时，应当绘制底色遮盖主题表头色
    const cellCover = primitives.find((p) => p.kind === 'rect' && p.x === 0 && p.y === 0 && p.width === 100);
    expect(cellCover).toBeDefined();
  });

  it('注册配色只控制区域颜色，框线形状来自独立预设', () => {
    tableThemeRegistry.registerTheme({
      id: 'custom-coral',
      label: '珊瑚粉双线',
      defaultHeaderRow: true,
      defaultBandedRows: true,
      defaultTotalRow: true,
      headerFill: '#F43F5E',
      headerText: '#FFFFFF',
      bandedFill: '#FFE4E6',
      totalFill: '#FECDD3',
      strokeColor: '#FDA4AF'
    });

    const content = nodeType.createContent({
      rowCount: 4,
      columnCount: 2
    });

    // 实例未显式设置 bandedRows/totalRow，应自动从注册的主题中继承为 true
    const mockNode: NodeEntity = {
      id: 'table-coral',
      type: 'node',
      nodeType: TABLE_NODE_TYPE,
      x: 0,
      y: 0,
      width: content.width,
      height: content.height,
      rotation: 0,
      zIndex: 'a0',
      locked: false,
      style: { fill: '#FFFFFF' },
      table: {
        ...content.table!,
        themeId: 'custom-coral',
        bandedRows: undefined,
        totalRow: undefined
      },
      textBlocks: content.textBlocks
    };

    const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    const primitives = nodeType.compose(mockNode, { theme });

    const gridLines = primitives.filter((p) => p.kind === 'line');
    expect(gridLines.length).toBeGreaterThan(0);
    expect(gridLines.every((p) => p.stroke === '#FDA4AF' && p.strokeWidth === 1)).toBe(true);

    // 检查表头文字继承主题 headerText #FFFFFF
    const headerText = primitives.find((p) => p.kind === 'text' && p.style.color === '#FFFFFF');
    expect(headerText).toBeDefined();
  });

  it('默认单元格策略为溢出省略 (ellipsis) 不自动撑开行高；设为自动撑高 (auto-height) 时按内容撑高与回缩', () => {
    const content = nodeType.createContent({ rowCount: 2, columnCount: 2 });
    const mockNode: NodeEntity = {
      id: 'table-auto-row',
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

    const firstBlock = content.textBlocks![0];
    expect(nodeType.measureBlockWidth(mockNode, firstBlock)).toBe(DEFAULT_COLUMN_WIDTH - 16);

    // 1. 默认状态 (ellipsis)：即使文本测量高度 80px，也不撑开行高，且图元样式为 textOverflow: 'ellipsis'
    const defaultBounds = nodeType.computeBounds(
      mockNode,
      new Map([['table:cell:0:0', { width: 84, height: 80, lineCount: 2 }]])
    );
    expect(defaultBounds.height).toBe(DEFAULT_ROW_HEIGHT * 2);
    expect(defaultBounds.patches).toBeUndefined();

    const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    const primitives = nodeType.compose(mockNode, { theme });
    const text00 = primitives.find((p) => p.kind === 'text' && p.id === 'table:cell:0:0');
    expect(text00?.kind === 'text' ? text00.style.textOverflow : undefined).toBe('ellipsis');

    // 2. 设为自动撑高 (auto-height)：模拟 (0,0) 单元格大字号折行后文本高 80px -> 行高应撑开为 80 + 12 = 92px
    const autoHeightNode: NodeEntity = {
      ...mockNode,
      table: {
        ...mockNode.table!,
        cellOverflow: 'auto-height'
      }
    };
    const expanded = nodeType.computeBounds(
      autoHeightNode,
      new Map([
        ['table:cell:0:0', { width: 84, height: 80, lineCount: 2 }],
        ['table:cell:0:1', { width: 40, height: 20, lineCount: 1 }]
      ])
    );
    expect(expanded.height).toBe(92 + DEFAULT_ROW_HEIGHT);
    expect(expanded.patches).toHaveLength(1);
    const expandedRows = (expanded.patches![0] as { value: Array<{ height?: number }> }).value;
    expect(expandedRows[0].height).toBe(92);

    // 3. 模拟字号恢复为小字号 (height: 18px) -> 行高自动回缩至默认基准 DEFAULT_ROW_HEIGHT (36px)
    const expandedNode: NodeEntity = {
      ...autoHeightNode,
      height: expanded.height,
      table: {
        ...autoHeightNode.table!,
        rows: expandedRows
      }
    };
    const shrunk = nodeType.computeBounds(
      expandedNode,
      new Map([['table:cell:0:0', { width: 40, height: 18, lineCount: 1 }]])
    );
    expect(shrunk.height).toBe(DEFAULT_ROW_HEIGHT * 2);
    expect(shrunk.patches).toHaveLength(1);
    const shrunkRows = (shrunk.patches![0] as { value: Array<{ height?: number }> }).value;
    expect(shrunkRows[0].height).toBe(DEFAULT_ROW_HEIGHT);
  });
});

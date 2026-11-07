import { describe, expect, it } from 'vitest';
import { LIGHT_CANVAS_THEME_SEED, deriveCanvasTheme } from '@skynote/core';
import type { NodeEntity } from '@skynote/core';
import { TableNodeType } from '../src/table-node';
import { composeTableControls, hitTableControl, tableControlGeometry } from '../src/table-controls';

function node(rows = 3, columns = 3): NodeEntity {
  return {
    ...new TableNodeType().createContent({ rowCount: rows, columnCount: columns }),
    id: 'controls',
    nodeType: 'table',
    type: 'node',
    x: 0,
    y: 0,
    rotation: 0,
    zIndex: 'a0',
    locked: false
  };
}

const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

describe('表格边缘控件几何', () => {
  it('行列选择、分界调整、边界插入与整体移动分别命中', () => {
    const geometry = tableControlGeometry(node(), matrix, 1);
    expect(hitTableControl(geometry, { x: 50, y: -10 })).toEqual({ kind: 'header', axis: 'column', index: 0 });
    expect(hitTableControl(geometry, { x: -10, y: 50 })).toEqual({ kind: 'header', axis: 'row', index: 1 });
    expect(hitTableControl(geometry, { x: 100, y: -4 })).toEqual({ kind: 'resize', axis: 'column', index: 0 });
    expect(hitTableControl(geometry, { x: 100, y: -16 })).toEqual({ kind: 'insert', axis: 'column', index: 1 });
    expect(hitTableControl(geometry, { x: -16, y: 36 })).toEqual({ kind: 'insert', axis: 'row', index: 1 });
    expect(hitTableControl(geometry, { x: 310, y: 54 })).toEqual({
      kind: 'insert',
      axis: 'column',
      index: 3,
      append: true
    });
    expect(hitTableControl(geometry, { x: 150, y: 118 })).toEqual({
      kind: 'insert',
      axis: 'row',
      index: 3,
      append: true
    });
    expect(hitTableControl(geometry, { x: 150, y: -34 })).toEqual({ kind: 'move' });
    expect(hitTableControl(geometry, { x: 50, y: 20 })).toBeNull();
  });

  it('缩放后控件保持屏幕尺寸，旋转后图元按世界矩阵投影', () => {
    const geometry = tableControlGeometry(node(), { a: 0, b: 1, c: -1, d: 0, e: 100, f: 100 }, 0.25);
    expect(hitTableControl(geometry, { x: 50, y: -40 })).toMatchObject({ kind: 'header', axis: 'column' });
    expect(hitTableControl(geometry, { x: 100, y: -64 })).toMatchObject({ kind: 'insert', index: 1 });
    const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    const primitives = composeTableControls(geometry, theme, null, null);
    const plus = primitives.find((primitive) => primitive.kind === 'circle');
    expect(plus).toMatchObject({ kind: 'circle', cx: 46, cy: 440, r: 32 });
    expect(new TableNodeType().extent(geometry.node as NodeEntity)).toEqual({
      left: 0,
      top: 0,
      right: 300,
      bottom: 108
    });
  });

  it('四侧加号以同一圆心绘制对称笔画，旋转缩放后仍居中', () => {
    const geometry = tableControlGeometry(node(), { a: 0, b: 1, c: -1, d: 0, e: 100, f: 100 }, 0.5);
    const theme = deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED });
    for (const axis of ['row', 'column'] as const) {
      const primitives = composeTableControls(geometry, theme, { kind: 'insert', axis, index: 1 }, null);
      for (let index = 0; index < primitives.length; index++) {
        const circle = primitives[index];
        if (circle.kind !== 'circle' || circle.r !== 16) continue;
        for (const bar of primitives.slice(index + 1, index + 3)) {
          expect(bar.kind).toBe('polygon');
          if (bar.kind !== 'polygon') continue;
          expect((bar.points[0] + bar.points[4]) / 2).toBeCloseTo(circle.cx);
          expect((bar.points[1] + bar.points[5]) / 2).toBeCloseTo(circle.cy);
        }
      }
    }
  });

  it('大表格只绘制控制带和当前目标，图元数量保持有界', () => {
    const geometry = tableControlGeometry(node(1000, 10), matrix, 1);
    const primitives = composeTableControls(
      geometry,
      deriveCanvasTheme({ seed: LIGHT_CANVAS_THEME_SEED }),
      { kind: 'header', axis: 'row', index: 400 },
      null
    );
    expect(primitives.length).toBeLessThan(30);
  });
});

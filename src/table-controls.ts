import { applyMatrix } from '@skynote/core';
import type { CanvasPrimitive, CanvasTheme, Matrix2D, NodeEntity, Point } from '@skynote/core';
import { computeTableTracks, nearestTableBoundary } from './layout';
import type { TableNodeFields, TableTracks } from './types';

export type TableTrackAxis = 'row' | 'column';
export type TableControlHit =
  | { kind: 'header' | 'resize'; axis: TableTrackAxis; index: number }
  | { kind: 'insert'; axis: TableTrackAxis; index: number; append?: boolean }
  | { kind: 'move' };

export interface TableTrackSelection {
  readonly nodeId: string;
  readonly axis: TableTrackAxis;
  readonly start: number;
  readonly end: number;
}

export interface TableControlGeometry {
  readonly node: Readonly<NodeEntity>;
  readonly matrix: Matrix2D;
  readonly zoom: number;
  readonly unitX: number;
  readonly unitY: number;
  readonly tracks: TableTracks;
}

const tracksByTable = new WeakMap<TableNodeFields, TableTracks>();

export function tableControlGeometry(node: Readonly<NodeEntity>, matrix: Matrix2D, zoom: number): TableControlGeometry {
  const table = node.table!;
  let tracks = tracksByTable.get(table);
  if (!tracks) {
    tracks = computeTableTracks(table.rowCount, table.columnCount, table.rows, table.columns);
    tracksByTable.set(table, tracks);
  }
  return {
    node,
    matrix,
    zoom,
    unitX: 1 / (zoom * Math.hypot(matrix.a, matrix.b)),
    unitY: 1 / (zoom * Math.hypot(matrix.c, matrix.d)),
    tracks
  };
}

export function hitTableControl(geometry: TableControlGeometry, local: Point): TableControlHit | null {
  const { node, tracks, unitX: ux, unitY: uy } = geometry;
  const { x, y } = local;
  if (Math.abs(x - node.width / 2) <= 26 * ux && y >= -42 * uy && y <= -26 * uy) return { kind: 'move' };
  if (Math.abs(x - node.width - 10 * ux) <= 8 * ux && Math.abs(y - node.height / 2) <= 8 * uy) {
    return { kind: 'insert', axis: 'column', index: tracks.colStarts.length - 1, append: true };
  }
  if (Math.abs(y - node.height - 10 * uy) <= 8 * uy && Math.abs(x - node.width / 2) <= 8 * ux) {
    return { kind: 'insert', axis: 'row', index: tracks.rowStarts.length - 1, append: true };
  }
  if (y >= -18 * uy && y < -4 * uy && x >= -8 * ux && x <= node.width + 8 * ux) {
    const index = nearestTableBoundary(tracks.colStarts, x);
    if (Math.abs(x - tracks.colStarts[index]) <= 8 * ux) return { kind: 'insert', axis: 'column', index };
  }
  if (x >= -18 * ux && x < -4 * ux && y >= -8 * uy && y <= node.height + 8 * uy) {
    const index = nearestTableBoundary(tracks.rowStarts, y);
    if (Math.abs(y - tracks.rowStarts[index]) <= 8 * uy) return { kind: 'insert', axis: 'row', index };
  }
  if (x >= 0 && x < node.width && y >= -16 * uy && y < 0) {
    const boundary = nearestTableBoundary(tracks.colStarts, x);
    if (boundary > 0 && Math.abs(x - tracks.colStarts[boundary]) <= 4 * ux) {
      return { kind: 'resize', axis: 'column', index: boundary - 1 };
    }
    const index = x < tracks.colStarts[boundary] ? boundary - 1 : boundary;
    return { kind: 'header', axis: 'column', index: Math.max(0, Math.min(tracks.colStarts.length - 2, index)) };
  }
  if (y >= 0 && y < node.height && x >= -16 * ux && x < 0) {
    const boundary = nearestTableBoundary(tracks.rowStarts, y);
    if (boundary > 0 && Math.abs(y - tracks.rowStarts[boundary]) <= 4 * uy) {
      return { kind: 'resize', axis: 'row', index: boundary - 1 };
    }
    const index = y < tracks.rowStarts[boundary] ? boundary - 1 : boundary;
    return { kind: 'header', axis: 'row', index: Math.max(0, Math.min(tracks.rowStarts.length - 2, index)) };
  }
  return null;
}

export function tableInsertAnchor(
  geometry: TableControlGeometry,
  hit: Extract<TableControlHit, { kind: 'insert' }>
): Point {
  const { node, matrix, tracks, unitX: ux, unitY: uy } = geometry;
  const column = hit.axis === 'column';
  return applyMatrix(
    matrix,
    column ? (hit.append ? node.width + 10 * ux : tracks.colStarts[hit.index]) : hit.append ? node.width / 2 : -10 * ux,
    column
      ? hit.append
        ? node.height / 2
        : -10 * uy
      : hit.append
        ? node.height + 10 * uy
        : tracks.rowStarts[hit.index]
  );
}

export function composeTableControls(
  geometry: TableControlGeometry,
  theme: CanvasTheme,
  hover: TableControlHit | null,
  selection: TableTrackSelection | null,
  guide?: { axis: TableTrackAxis; index: number }
): CanvasPrimitive[] {
  const { node, matrix, zoom, unitX: ux, unitY: uy, tracks } = geometry;
  const color = theme.selectionStroke;
  const primitives: CanvasPrimitive[] = [];
  const point = (x: number, y: number): Point => applyMatrix(matrix, x, y);
  const rect = (x: number, y: number, width: number, height: number, opacity: number, outline = false): void => {
    const points = [point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)];
    primitives.push({
      kind: 'polygon',
      points: points.flatMap((p) => [p.x, p.y]),
      fill: color,
      fillOpacity: opacity,
      cornerRadius: 3 / zoom,
      ...(outline ? { stroke: color, strokeWidth: 1 / zoom } : {})
    });
  };
  const line = (x1: number, y1: number, x2: number, y2: number, width = 1, opacity = 1): void => {
    const a = point(x1, y1);
    const b = point(x2, y2);
    primitives.push({
      kind: 'line',
      points: [a.x, a.y, b.x, b.y],
      stroke: color,
      strokeWidth: width / zoom,
      strokeOpacity: opacity
    });
  };
  const band = (axis: TableTrackAxis, start: number, end: number, opacity: number): void => {
    if (axis === 'column')
      rect(tracks.colStarts[start], -16 * uy, tracks.colStarts[end + 1] - tracks.colStarts[start], 12 * uy, opacity);
    else rect(-16 * ux, tracks.rowStarts[start], 12 * ux, tracks.rowStarts[end + 1] - tracks.rowStarts[start], opacity);
  };
  rect(0, -16 * uy, node.width, 12 * uy, 0.06);
  rect(-16 * ux, 0, 12 * ux, node.height, 0.06);
  if (selection?.nodeId === node.id) band(selection.axis, selection.start, selection.end, 0.22);
  if (hover?.kind === 'header') {
    band(hover.axis, hover.index, hover.index, 0.28);
    const start = hover.axis === 'column' ? tracks.colStarts[hover.index] : tracks.rowStarts[hover.index];
    const end = hover.axis === 'column' ? tracks.colStarts[hover.index + 1] : tracks.rowStarts[hover.index + 1];
    const center = (start + end) / 2;
    const p =
      hover.axis === 'column'
        ? [point(center - 3 * ux, -12 * uy), point(center + 3 * ux, -12 * uy), point(center, -8 * uy)]
        : [point(-12 * ux, center - 3 * uy), point(-12 * ux, center + 3 * uy), point(-8 * ux, center)];
    primitives.push({ kind: 'polygon', points: p.flatMap((value) => [value.x, value.y]), fill: color });
  }

  const plus = (x: number, y: number, active: boolean): void => {
    const center = point(x, y);
    primitives.push({
      kind: 'circle',
      cx: center.x,
      cy: center.y,
      r: 8 / zoom,
      fill: active ? color : theme.background,
      stroke: active ? color : theme.nodeStroke,
      strokeWidth: 1 / zoom
    });
    const ink = active ? theme.background : theme.foreground;
    for (const [dx, dy] of [
      [4 * ux, 0],
      [0, 4 * uy]
    ]) {
      const halfX = dx || 0.75 * ux;
      const halfY = dy || 0.75 * uy;
      const corners = [
        point(x - halfX, y - halfY),
        point(x + halfX, y - halfY),
        point(x + halfX, y + halfY),
        point(x - halfX, y + halfY)
      ];
      primitives.push({
        kind: 'polygon',
        points: corners.flatMap((p) => [p.x, p.y]),
        fill: ink,
        cornerRadius: 0.75 / zoom
      });
    }
  };
  const appendColumn = hover?.kind === 'insert' && hover.axis === 'column' && !!hover.append;
  const appendRow = hover?.kind === 'insert' && hover.axis === 'row' && !!hover.append;
  plus(node.width + 10 * ux, node.height / 2, appendColumn);
  plus(node.width / 2, node.height + 10 * uy, appendRow);
  if (hover && hover.kind !== 'move' && !(hover.kind === 'insert' && hover.append)) {
    const index = hover.kind === 'insert' ? hover.index : hover.index + 1;
    const x = hover.axis === 'column' ? tracks.colStarts[index] : -10 * ux;
    const y = hover.axis === 'row' ? tracks.rowStarts[index] : -10 * uy;
    plus(x, y, hover.kind === 'insert');
    if (hover.kind === 'insert' || hover.kind === 'resize') {
      if (hover.axis === 'column') line(tracks.colStarts[index], 0, tracks.colStarts[index], node.height, 1.5);
      else line(0, tracks.rowStarts[index], node.width, tracks.rowStarts[index], 1.5);
    }
  }
  rect(node.width / 2 - 24 * ux, -40 * uy, 48 * ux, 12 * uy, hover?.kind === 'move' ? 0.3 : 0.12, true);
  for (const dx of [-5, 0, 5]) {
    for (const dy of [-2, 2]) {
      const dot = point(node.width / 2 + dx * ux, (-34 + dy) * uy);
      primitives.push({ kind: 'circle', cx: dot.x, cy: dot.y, r: 1 / zoom, fill: color });
    }
  }
  if (guide) {
    if (guide.axis === 'column')
      line(tracks.colStarts[guide.index], -16 * uy, tracks.colStarts[guide.index], node.height, 3);
    else line(-16 * ux, tracks.rowStarts[guide.index], node.width, tracks.rowStarts[guide.index], 3);
  }
  return primitives;
}

import type { TableGridStyle, TableGridStyleDefinition } from './types';

export const TABLE_GRID_STYLES: readonly TableGridStyleDefinition[] = [
  { id: 'grid', label: '经典网格', defaultOuterBorder: true, strokeWidth: 1 },
  { id: 'outline', label: '四周包围', defaultOuterBorder: true, strokeWidth: 1 },
  { id: 'none', label: '无边框', defaultOuterBorder: false, strokeWidth: 1 },
  {
    id: 'three-line',
    label: '三线表',
    defaultOuterBorder: true,
    defaultOuterSides: { top: true, bottom: true, left: false, right: false },
    strokeWidth: 1,
    outerBorder: { width: 2 },
    topBorder: { width: 2 },
    headerBottomBorder: { width: 1 },
    bottomBorder: { width: 2 },
    totalTopBorder: { width: 1 }
  },
  { id: 'horizontal', label: '极简横线', defaultOuterBorder: false, strokeWidth: 1 }
];

export function getTableGridStyle(style: TableGridStyle = 'grid'): TableGridStyleDefinition {
  return TABLE_GRID_STYLES.find((grid) => grid.id === style)!;
}

/**
 * @file themes.ts
 * @description 表格配色预设与统一注册中心：所有主题均经注册接入，支持外部扩展与用户自定义
 */

import { parseCssColor, resolveThemeColor } from '@skynote/core';
import type { CanvasTheme, RgbaColor } from '@skynote/core';
import type { TableThemeDefinition } from './types';

/** 主题色只接受不透明颜色或主题Token，避免将整表设为不可见。 */
export function isTableThemeColor(color: string): boolean {
  const parsed = parseCssColor(color);
  return parsed ? parsed.a === 1 : /^\$[a-zA-Z][\w]*$/.test(color);
}

/** 自定义色派生整表区域配色，不修改框线和单元格局部覆盖。 */
export function withTableThemeColor(
  theme: TableThemeDefinition,
  color: string | undefined,
  canvas: CanvasTheme
): TableThemeDefinition {
  if (color === undefined) return theme;
  const headerText = tableTextColor(parseCssColor(resolveThemeColor(color, canvas, canvas.nodeFill)!)!, canvas);
  return {
    ...theme,
    headerFill: color,
    headerText,
    headerColFill: color,
    headerColText: '$foreground',
    bandedFill: color,
    totalFill: color,
    totalText: '$foreground',
    strokeColor: color
  };
}

/** 根据最终叠色后的背景选取文字色，局部底色和主题色使用同一算法。 */
export function tableTextColor(background: Readonly<RgbaColor>, canvas: CanvasTheme): string {
  const luminance = (value: string | Readonly<RgbaColor>): number => {
    const rgb = typeof value === 'string' ? parseCssColor(value)! : value;
    const linear = [rgb.r, rgb.g, rgb.b].map((channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const fill = luminance(background);
  const contrast = (value: string): number => {
    const text = luminance(value);
    return (Math.max(fill, text) + 0.05) / (Math.min(fill, text) + 0.05);
  };
  return contrast(canvas.foreground) >= contrast(canvas.background) ? '$foreground' : '$background';
}

export const DEFAULT_TABLE_THEME_ID = 'plain-grid';

/** 默认后备配色 (极端异常或注册表清空时使用) */
export const FALLBACK_TABLE_THEME: TableThemeDefinition = {
  id: 'plain-grid',
  label: '默认配色',
  defaultHeaderRow: true,
  defaultHeaderColumn: false,
  defaultBandedRows: false,
  defaultTotalRow: false,
  headerFill: '$nodeFill',
  headerAlign: 'center',
  bodyAlign: 'left',
  strokeColor: '$nodeStroke'
};

/** 内置表格预设主题清单 (通过统一注册接入) */
export const BUILTIN_TABLE_THEMES: readonly TableThemeDefinition[] = [
  FALLBACK_TABLE_THEME,
  {
    id: 'business-blue',
    label: '商务蓝',
    defaultHeaderRow: true,
    defaultHeaderColumn: false,
    defaultBandedRows: true,
    defaultTotalRow: false,
    headerFill: '$blue',
    headerText: '$background',
    headerAlign: 'center',
    bodyAlign: 'left',
    bandedFill: '$blue',
    bandedFillOpacity: 0.08,
    totalFill: '$blue',
    totalText: '$background',
    strokeColor: '$blue'
  },
  {
    id: 'corporate-slate',
    label: '沉稳灰',
    defaultHeaderRow: true,
    defaultHeaderColumn: false,
    defaultBandedRows: true,
    defaultTotalRow: false,
    headerFill: '$nodeFill',
    headerAlign: 'center',
    bodyAlign: 'left',
    bandedFill: '$nodeFill',
    bandedFillOpacity: 0.08,
    totalFill: '$nodeFill',
    strokeColor: '$nodeStroke'
  },
  {
    id: 'fresh-emerald',
    label: '清爽绿',
    defaultHeaderRow: true,
    defaultHeaderColumn: false,
    defaultBandedRows: true,
    defaultTotalRow: false,
    headerFill: '$green',
    headerText: '$background',
    headerAlign: 'center',
    bodyAlign: 'left',
    bandedFill: '$green',
    bandedFillOpacity: 0.08,
    totalFill: '$green',
    totalText: '$background',
    strokeColor: '$green'
  },
  {
    id: 'active-amber',
    label: '活力橙',
    defaultHeaderRow: true,
    defaultHeaderColumn: false,
    defaultBandedRows: true,
    defaultTotalRow: false,
    headerFill: '$orange',
    headerText: '$background',
    headerAlign: 'center',
    bodyAlign: 'left',
    bandedFill: '$orange',
    bandedFillOpacity: 0.08,
    totalFill: '$orange',
    totalText: '$background',
    strokeColor: '$orange'
  }
];

/** 表格主题注册表 */
export class TableThemeRegistry {
  private readonly themes = new Map<string, TableThemeDefinition>();

  /** 注册或替换一个主题定义 */
  registerTheme(theme: TableThemeDefinition): void {
    this.themes.set(theme.id, theme);
  }

  /** 注销指定主题 */
  unregisterTheme(id: string): boolean {
    if (id === DEFAULT_TABLE_THEME_ID) return false;
    return this.themes.delete(id);
  }

  /** 获取指定主题，若未找到则安全回退到默认配色 */
  getTheme(id: string | undefined): TableThemeDefinition {
    if (id && this.themes.has(id)) {
      return this.themes.get(id)!;
    }
    return this.themes.get(DEFAULT_TABLE_THEME_ID) ?? FALLBACK_TABLE_THEME;
  }

  /** 列出当前全部已注册主题 */
  listThemes(): readonly TableThemeDefinition[] {
    return Array.from(this.themes.values());
  }

  /** 清空除兜底外的所有主题 */
  clear(): void {
    this.themes.clear();
    this.themes.set(FALLBACK_TABLE_THEME.id, FALLBACK_TABLE_THEME);
  }
}

/** 将内置预设主题全部经注册通道录入注册表 */
export function registerBuiltinThemes(registry: TableThemeRegistry): void {
  for (const theme of BUILTIN_TABLE_THEMES) {
    registry.registerTheme(theme);
  }
}

/** 单例主题注册表：初始化时通过注册通道装载内置主题 */
export const tableThemeRegistry = new TableThemeRegistry();
registerBuiltinThemes(tableThemeRegistry);

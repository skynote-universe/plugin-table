/**
 * @file index.ts
 * @description 表格插件统一公共导出
 */

import type { SkyNotePlugin } from '@skynote/core';
import { TablePlugin } from './table-plugin';

export * from './types';
export * from './themes';
export * from './grid-styles';
export * from './border-edit';
export * from './layout';
export * from './operations';
export * from './table-node';
export * from './table-plugin';

/** 商业插件包的统一入口约定：宿主按此装配 (是否启用由宿主的 FeatureGate 决定) */
export function createPlugins(): SkyNotePlugin[] {
  return [new TablePlugin()];
}

/**
 * 提供最小化的原始内容边界，保证用户输入、业务标识和 Agent 原始产出不被产品界面翻译。
 * 组件只生成一个带明确原始类型的 span，不向父级或相邻产品文本扩散边界。
 */

import type { HTMLAttributes } from 'react';

export type RawContentProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  value: string;
};

export type RawIdentifierProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  value: string;
};

/**
 * 原样渲染用户输入、知识内容或 Agent 输出；value 必须保持原始字符串，组件不翻译、不改写且不改变父级状态。
 */
export function RawContent({ value, ...attributes }: RawContentProps) {
  return (
    <span {...attributes} data-i18n-raw-kind="content" translate="no">
      {value}
    </span>
  );
}

/**
 * 原样渲染员工名、路径、URL 或其他业务标识；value 不进入产品消息键，组件只影响自身节点。
 */
export function RawIdentifier({ value, ...attributes }: RawIdentifierProps) {
  return (
    <span {...attributes} data-i18n-raw-kind="identifier" translate="no">
      {value}
    </span>
  );
}

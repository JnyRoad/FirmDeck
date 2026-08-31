/**
 * 定义产品消息的稳定描述对象，供 React 组件和非 React sink 共享同一套 ID 与具名参数契约。
 * 描述对象只携带消息 ID 和参数，不负责翻译，也不读取全局 locale 或修改用户数据。
 */

import type { MessageValues } from './imperative';
import type { MessageId } from './types';

export type MessageDescriptor = Readonly<{
  id: MessageId;
  values?: MessageValues;
}>;

/**
 * 创建带稳定语义 ID 的消息描述对象；id 必须来自生成的 MessageId，values 使用具名参数且不会拼接进 ID。
 */
export function createMessageDescriptor<TMessageId extends MessageId>(
  id: TMessageId,
  values?: MessageValues,
): MessageDescriptor {
  return values === undefined ? { id } : { id, values: { ...values } };
}

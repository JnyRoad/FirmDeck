import * as React from 'react';

import type { MessageDescriptor } from '@/i18n/descriptors';
import { useAppIntl } from '@/i18n/useAppIntl';
import { cn } from '@/lib/utils';

type LocalizedTextareaAttribute = string | MessageDescriptor;
type MessageTranslator = (id: MessageDescriptor['id'], values?: MessageDescriptor['values']) => string;

export type TextareaProps = Omit<
  React.ComponentProps<'textarea'>,
  'placeholder' | 'title' | 'aria-label'
> & {
  placeholder?: LocalizedTextareaAttribute;
  title?: LocalizedTextareaAttribute;
  'aria-label'?: LocalizedTextareaAttribute;
};

/** 判断一个属性值是否为受控的产品消息描述对象，而不是用户或业务原始字符串。 */
function isMessageDescriptor(value: unknown): value is MessageDescriptor {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { id?: unknown }).id === 'string';
}

/** 只翻译明确的 MessageDescriptor，普通字符串保持原样并继续作为原始输入值传递。 */
function resolveTextareaAttribute(
  value: LocalizedTextareaAttribute | undefined,
  translate: MessageTranslator,
): string | undefined {
  return isMessageDescriptor(value) ? translate(value.id, value.values) : value;
}

/** 渲染带可本地化属性的多行输入框；仅 descriptor 属性进入 i18n，普通字符串不会被隐式翻译。 */
function Textarea({ className, ...props }: TextareaProps) {
  const { t } = useAppIntl();
  const localizedProps = {
    ...props,
    placeholder: resolveTextareaAttribute(props.placeholder, t),
    title: resolveTextareaAttribute(props.title, t),
    'aria-label': resolveTextareaAttribute(props['aria-label'], t),
  };

  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-fixed min-h-16 w-full overflow-y-auto rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm',
        className
      )}
      {...localizedProps}
    />
  )
}

export { Textarea };

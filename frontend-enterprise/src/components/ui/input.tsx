import * as React from 'react';

import type { MessageDescriptor } from '@/i18n/descriptors';
import { useAppIntl } from '@/i18n/useAppIntl';
import { cn } from '@/lib/utils';

type LocalizedInputAttribute = string | MessageDescriptor;
type MessageTranslator = (id: MessageDescriptor['id'], values?: MessageDescriptor['values']) => string;

export type InputProps = Omit<
  React.ComponentProps<'input'>,
  'placeholder' | 'title' | 'aria-label'
> & {
  placeholder?: LocalizedInputAttribute;
  title?: LocalizedInputAttribute;
  'aria-label'?: LocalizedInputAttribute;
};

/** 判断一个属性值是否为受控的产品消息描述对象，而不是用户或业务原始字符串。 */
function isMessageDescriptor(value: unknown): value is MessageDescriptor {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { id?: unknown }).id === 'string';
}

/** 只翻译明确的 MessageDescriptor，普通字符串保持原样并继续作为原始输入值传递。 */
function resolveInputAttribute(
  value: LocalizedInputAttribute | undefined,
  translate: MessageTranslator,
): string | undefined {
  return isMessageDescriptor(value) ? translate(value.id, value.values) : value;
}

/** 渲染带可本地化属性的输入框；仅 descriptor 属性进入 i18n，普通字符串不会被隐式翻译。 */
function Input({ className, type, ...props }: InputProps) {
  const { t } = useAppIntl();
  const localizedProps = {
    ...props,
    placeholder: resolveInputAttribute(props.placeholder, t),
    title: resolveInputAttribute(props.title, t),
    'aria-label': resolveInputAttribute(props['aria-label'], t),
  };

  return (
    <input
      type={type}
      data-slot="input"
      autoComplete="off"
      data-1p-ignore="true"
      data-lpignore="true"
      data-bwignore="true"
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm',
        className
      )}
      {...localizedProps}
    />
  )
}

export { Input };

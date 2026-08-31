type DialogProps = {
  title: string;
};

/** Provide a local component so the fixture remains valid TSX while exercising its title sink. */
function Dialog({ title }: DialogProps) {
  return <section data-title={title} />;
}

/** Exercise expression, interpolated-template, and conditional JSX attribute literals. */
export function InvalidExpressionAttributes({
  mode,
  name,
}: {
  mode: 'plaza' | 'employee';
  name: string;
}) {
  return (
    <>
      <input aria-label={'Channel identity'} />
      <section title={`${name} identity binding`} />
      <Dialog title={mode === 'plaza' ? 'Copy from plaza' : 'Copy from employee'} />
    </>
  );
}

import { toast } from 'sonner';

type LayoutKey = 'force' | 'hierarchy';

const UI_COPY = {
  pageTitle: 'Knowledge graph settings',
  tableTitle: 'Audit history',
  description: 'Choose a layout for the graph',
};

const LAYOUT_LABELS: Record<LayoutKey, string> = {
  force: 'Force-directed layout',
  hierarchy: 'Hierarchy layout',
};

const STATUS_LABELS = {
  pending: 'Pending approval',
  failed: 'Failed to publish',
};

const ACTIONS = [{ key: 'export', label: 'Export report' }];

/** Build a product title through a local helper so the checker must preserve its source evidence. */
function buildPageTitle() {
  return `${UI_COPY.pageTitle} - StaffDeck`;
}

/** Resolve a product status from a local label map without translating an external status value. */
function getStatusLabel(status: string) {
  return STATUS_LABELS[status as keyof typeof STATUS_LABELS];
}

/** Build a product notification through a local helper and a static suffix. */
function buildFailureNotice() {
  return 'Could not save ' + 'layout';
}

/** Build a native confirmation message through a local helper. */
function buildConfirmMessage() {
  return UI_COPY.description;
}

/** Exercise local object, array, helper, template, concatenation, and non-DOM sink dataflow. */
export function InvalidLocalDataflow({
  layout,
  status,
}: {
  layout: LayoutKey;
  status: string;
}) {
  const layoutLabel = LAYOUT_LABELS[layout];
  const statusLabel = getStatusLabel(status);
  const pageTitle = buildPageTitle();
  const exportName = ACTIONS[0].label + '.csv';
  const eventPayload = { message: buildFailureNotice() };

  document.title = pageTitle;
  window.confirm(buildConfirmMessage());
  toast.error(buildFailureNotice());
  window.postMessage(eventPayload, '*');

  return (
    <section title={UI_COPY.tableTitle}>
      <h1>{layoutLabel}</h1>
      <p>{statusLabel}</p>
      <p>{UI_COPY.description}</p>
      <input defaultValue={pageTitle} placeholder={UI_COPY.description} />
      <button title={ACTIONS[0].label}>{ACTIONS[0].label}</button>
      <a download={exportName} href="/audit.csv">Export</a>
    </section>
  );
}

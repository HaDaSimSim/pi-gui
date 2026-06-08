import { Loader2, X } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { cn } from '@/lib/utils';
import { useT } from './i18n';

interface OpenTab {
  path: string;
  label: string;
  cwd?: string;
}

interface TabStripProps {
  tabs: OpenTab[];
  activeTab: string | undefined;
  unread: Set<string>;
  streaming: Set<string>;
  onReorder: (next: OpenTab[]) => void;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

// Tab strip with drag reorder + layout animation via motion's Reorder.
// Reorder.Group handles the live position swaps and the smooth slide; we only
// supply the value list and an onReorder. The whole tab is draggable, but the
// close button stops propagation so clicking X never starts a drag.
export function TabStrip({
  tabs,
  activeTab,
  unread,
  streaming,
  onReorder,
  onActivate,
  onClose,
}: TabStripProps) {
  return (
    <Reorder.Group
      as="div"
      axis="x"
      values={tabs}
      onReorder={onReorder}
      className="flex min-w-0 items-center gap-1"
    >
      {tabs.map((tab) => (
        <TabItem
          key={tab.path}
          tab={tab}
          active={tab.path === activeTab}
          unread={unread.has(tab.path) && tab.path !== activeTab}
          streaming={streaming.has(tab.path)}
          onActivate={onActivate}
          onClose={onClose}
        />
      ))}
    </Reorder.Group>
  );
}

function TabItem({
  tab,
  active,
  unread,
  streaming,
  onActivate,
  onClose,
}: {
  tab: OpenTab;
  active: boolean;
  unread: boolean;
  streaming: boolean;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const { t } = useT();
  const controls = useDragControls();
  return (
    <Reorder.Item
      as="div"
      value={tab}
      dragListener={false}
      dragControls={controls}
      onPointerDown={(e) => controls.start(e)}
      className={cn(
        'group flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm select-none',
        active
          ? 'border-primary font-medium'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
      role="tab"
      tabIndex={0}
      aria-selected={active}
      onClick={() => onActivate(tab.path)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate(tab.path);
        }
      }}
    >
      {streaming ? (
        <Loader2
          className="size-3 shrink-0 animate-spin text-primary"
          role="status"
          aria-label={t('tabs.streaming')}
        />
      ) : null}
      <div className="flex min-w-0 flex-col">
        <span className="max-w-[140px] truncate leading-tight">{tab.label}</span>
        {tab.cwd ? (
          <span className="max-w-[140px] truncate text-[10px] leading-tight text-muted-foreground/70">
            {tab.cwd.replace(/\/$/, '').split('/').pop()}
          </span>
        ) : null}
      </div>
      {unread ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-sky-500"
          role="status"
          aria-label={t('tabs.unread')}
        />
      ) : null}
      <button
        type="button"
        aria-label={t('sessions.closeSession')}
        className="rounded p-0.5 opacity-50 hover:bg-accent hover:opacity-100"
        // Stop pointer-down from reaching the drag controls / starting a drag.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.path);
        }}
      >
        <X className="size-3" />
      </button>
    </Reorder.Item>
  );
}

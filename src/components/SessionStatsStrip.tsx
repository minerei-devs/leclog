export interface SessionStatsStripItem {
  label: string;
  value: string;
  title?: string;
}

interface SessionStatsStripProps {
  items: SessionStatsStripItem[];
}

export function SessionStatsStrip({ items }: SessionStatsStripProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <dl className="session-stats-strip">
      {items.map((item) => (
        <div key={item.label} title={item.title ?? `${item.label}: ${item.value}`}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

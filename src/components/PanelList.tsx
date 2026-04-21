import type { ReactNode } from "react";

interface PanelListRow {
  label: string;
  value: ReactNode;
  action?: ReactNode;
}

interface PanelListProps {
  rows: PanelListRow[];
}

export function PanelList({ rows }: PanelListProps) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <dl className="panel-list">
      {rows.map((row) => (
        <div key={row.label} className="panel-list-row">
          <dt>{row.label}</dt>
          <dd>
            <span className="panel-list-value">{row.value}</span>
            {row.action ? <span className="panel-list-action">{row.action}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

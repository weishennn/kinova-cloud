import type { ReactNode } from 'react';

type CockpitPageHeadingProps = {
  title: string;
  description: string;
  action?: ReactNode;
};

export function CockpitPageHeading({ title, description, action }: CockpitPageHeadingProps) {
  return (
    <header className="cockpit-page-heading">
      <div className="cockpit-page-heading-copy">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="cockpit-page-actions">{action}</div>}
    </header>
  );
}

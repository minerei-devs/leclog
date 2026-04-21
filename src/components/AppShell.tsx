import type { PropsWithChildren } from "react";
import { Link, useLocation } from "react-router-dom";

export function AppShell({ children }: PropsWithChildren) {
  const location = useLocation();
  const isHome = location.pathname === "/";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Minerei</p>
          <h1>Leclog</h1>
        </div>

        {!isHome ? (
          <Link className="ghost-button" to="/">
            Sessions
          </Link>
        ) : null}
      </header>

      <main className="content">{children}</main>
    </div>
  );
}

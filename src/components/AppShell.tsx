import type { PropsWithChildren } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

export function AppShell({ children }: PropsWithChildren) {
  const location = useLocation();
  const isHome = location.pathname === "/";
  const isRecordingRoute = location.pathname.startsWith("/recording/");

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Minerei</p>
          <h1>Leclog</h1>
        </div>

        {!isHome && !isRecordingRoute ? (
          <Link className="ghost-button" to="/">
            <ArrowLeft className="button-icon" size={16} />
            Sessions
          </Link>
        ) : null}
      </header>

      <main className="content">{children}</main>
    </div>
  );
}

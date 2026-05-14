import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
const searchParams = new URLSearchParams(window.location.search);

if (import.meta.env.DEV && searchParams.has("m1-smoke")) {
  void import("./smoke/M1TranscriptSmokeApp").then(({ M1TranscriptSmokeApp }) => {
    root.render(
      <React.StrictMode>
        <M1TranscriptSmokeApp />
      </React.StrictMode>,
    );
  });
} else {
  void import("./App").then(({ default: App }) => {
    root.render(
      <React.StrictMode>
        <HashRouter>
          <App />
        </HashRouter>
      </React.StrictMode>,
    );
  });
}

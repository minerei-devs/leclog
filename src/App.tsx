import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { RecordingPage } from "./components/RecordingPage";
import { SessionDetailPage } from "./components/SessionDetailPage";
import { SessionListPage } from "./components/SessionListPage";

function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate replace to="/new" />} />
        <Route path="/new" element={<SessionListPage />} />
        <Route path="/settings" element={<Navigate replace to="/new" />} />
        <Route path="/resources" element={<Navigate replace to="/new" />} />
        <Route path="/recording/:sessionId" element={<RecordingPage />} />
        <Route path="/session/:sessionId" element={<SessionDetailPage />} />
      </Routes>
    </AppShell>
  );
}

export default App;

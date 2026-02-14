import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Layout, Menu } from "antd";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";

import MasterPage from "./pages/MasterPage";
import TasksPage from "./pages/TasksPage";
import GroupsPage from "./pages/GroupsPage";
import AccountsPage from "./pages/AccountsPage";
import SettingsPage from "./pages/SettingsPage";
import LoginPage from "./pages/LoginPage";
import { http } from "./lib/api";
import { setActiveWs } from "./lib/workspace";
import { clearAuth, isLoggedIn } from "./lib/auth";
import { getSocket } from "./lib/socket";

function getWsFromSearch(search: string) {
  try {
    const sp = new URLSearchParams(search);
    return sp.get("ws") || "";
  } catch {
    return "";
  }
}

function withWsPath(path: string, ws: string) {
  return `${path}?ws=${encodeURIComponent(ws)}`;
}

type WorkspaceLayoutProps = {
  ws: string;
  buildPath: (path: string) => string;
  children: ReactNode;
};

function WorkspaceLayout({ ws, buildPath, children }: WorkspaceLayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const selectedKey = location.pathname.includes("/groups")
    ? "groups"
    : location.pathname.includes("/accounts")
    ? "accounts"
    : location.pathname.includes("/settings")
    ? "settings"
    : "tasks";

  const items = [
    { key: "tasks", label: <Link to={buildPath("/tasks")}>任务</Link> },
    { key: "groups", label: <Link to={buildPath("/groups")}>群</Link> },
    { key: "accounts", label: <Link to={buildPath("/accounts")}>账号</Link> },
    { key: "settings", label: <Link to={buildPath("/settings")}>设置</Link> },
  ];

  const handleLogout = () => {
    clearAuth();
    navigate("/login", { replace: true });
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Header style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ color: "#fff", fontWeight: 800, fontSize: 16 }}>WS中控 - </div>

        <WorkspaceTitle ws={ws} />

        <Menu theme="dark" mode="horizontal" selectedKeys={[selectedKey]} items={items} style={{ flex: 1 }} />

        <Button danger onClick={handleLogout}>
          退出
        </Button>
      </Layout.Header>

      <Layout.Content style={{ padding: 16 }}>{children}</Layout.Content>
    </Layout>
  );
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />;
  return children;
}

function LoginRoute() {
  if (isLoggedIn()) return <Navigate to="/" replace />;
  return <LoginPage />;
}

function WorkspaceTitle({ ws }: { ws: string }) {
  const [taskName, setTaskName] = useState<string>("");

  useEffect(() => {
    let alive = true;
    async function loadProjectName() {
      if (!ws) return;
      try {
        const r = await http.get(`/api/projects/${encodeURIComponent(ws)}`);
        const data = r.data;
        if (!alive) return;
        if (data?.ok && data?.data?.name) setTaskName(String(data.data.name));
        else if (data?.data?.name) setTaskName(String(data.data.name));
        else setTaskName(ws);
      } catch {
        if (!alive) return;
        setTaskName(ws);
      }
    }
    loadProjectName();
    return () => {
      alive = false;
    };
  }, [ws]);

  return (
    <div
      title={`${taskName || ws} (${ws})`}
      style={{
        color: "#fff",
        fontWeight: 800,
        fontSize: 16,
        maxWidth: 260,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        opacity: 0.95,
      }}
    >
      {`${taskName || ws} (${ws})`}
    </div>
  );
}

function LegacyWorkspaceApp() {
  const location = useLocation();
  const navigate = useNavigate();

  const wsUrl = useMemo(() => getWsFromSearch(location.search), [location.search]);

  useEffect(() => {
    if (wsUrl) sessionStorage.setItem("ws", wsUrl);
  }, [wsUrl]);

  const ws = wsUrl || sessionStorage.getItem("ws") || "";
  const inWorkspace = !!ws;

  useEffect(() => {
    if (ws) {
      setActiveWs(ws);
      getSocket(ws);
    }
  }, [ws]);

  useEffect(() => {
    if (!wsUrl) {
      const saved = sessionStorage.getItem("ws");
      if (saved) {
        const p = location.pathname;
        const isWorkspacePath =
          p === "/tasks" || p === "/groups" || p === "/accounts" || p === "/settings" || p === "/";
        if (isWorkspacePath) {
          navigate(withWsPath(p === "/" ? "/tasks" : p, saved), { replace: true });
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search]);

  if (!inWorkspace) return <MasterPage />;

  return (
    <WorkspaceLayout ws={ws} buildPath={(path) => withWsPath(path, ws)}>
      <Routes>
        <Route path="/" element={<Navigate to={withWsPath("/tasks", ws)} replace />} />
        <Route path="/project" element={<Navigate to={withWsPath("/tasks", ws)} replace />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/groups" element={<GroupsPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to={withWsPath("/tasks", ws)} replace />} />
      </Routes>
    </WorkspaceLayout>
  );
}

function WorkspaceApp() {
  const { wid } = useParams();
  const ws = wid || "";

  useEffect(() => {
    if (ws) {
      setActiveWs(ws);
      getSocket(ws);
    }
  }, [ws]);

  if (!ws) return <MasterPage />;

  return (
    <WorkspaceLayout ws={ws} buildPath={(path) => `/w/${ws}${path}`}>
      <Routes>
        <Route index element={<Navigate to="tasks" replace />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="groups" element={<GroupsPage />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="tasks" replace />} />
      </Routes>
    </WorkspaceLayout>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route
        path="/w/:wid/*"
        element={
          <ProtectedRoute>
            <WorkspaceApp />
          </ProtectedRoute>
        }
      />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <LegacyWorkspaceApp />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

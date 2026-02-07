import { useEffect, useMemo, useState } from "react";
import { Layout, Tabs, Tag, Typography } from "antd";
import { Routes, Route, useLocation, useNavigate } from "react-router-dom";
import TasksPage from "./pages/TasksPage";
import GroupsPage from "./pages/GroupsPage";
import AccountsPage from "./pages/AccountsPage";
import SettingsPage from "./pages/SettingsPage";
import MasterPage from "./pages/MasterPage";
import { getSocket } from "./lib/socket";
import "./topTabs.css";

const { Header, Content } = Layout;

export default function App() {
  const nav = useNavigate();
  const loc = useLocation();
  const [socketOk, setSocketOk] = useState(false);
  const wsId = useMemo(() => {
    const params = new URLSearchParams(loc.search);
    return (params.get("ws") || "").trim();
  }, [loc.search]);

  const active = useMemo(() => {
    if (loc.pathname.startsWith("/groups")) return "groups";
    if (loc.pathname.startsWith("/accounts")) return "accounts";
    if (loc.pathname.startsWith("/settings")) return "settings";
    return "tasks";
  }, [loc.pathname]);

  useEffect(() => {
    if (!wsId) return;
    const s = getSocket();
    const onC = () => setSocketOk(true);
    const onD = () => setSocketOk(false);
    s.on("connect", onC);
    s.on("disconnect", onD);
    setSocketOk(s.connected);
    return () => {
      s.off("connect", onC);
      s.off("disconnect", onD);
    };
  }, [wsId]);

  if (!wsId) {
    return <MasterPage />;
  }

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header style={{ background: "#0b1d2a", display: "flex", alignItems: "center", gap: 16 }}>
        <Typography.Title level={4} style={{ margin: 0, color: "#fff", minWidth: 140 }}>
          WA 控制台
        </Typography.Title>
<Tabs
          activeKey={active}
          className="topTabs"
          onChange={(k) => {
            if (k === "tasks") nav("/");
            if (k === "groups") nav("/groups");
            if (k === "accounts") nav("/accounts");
            if (k === "settings") nav("/settings");
          }}
          items={[
            { key: "tasks", label: "任务" },
            { key: "groups", label: "群" },
            { key: "accounts", label: "账号" },
            { key: "settings", label: "设置" },
          ]}
          style={{ flex: 1 }}
        />

        <Tag color={socketOk ? "green" : "red"} style={{ margin: 0 }}>
          Socket {socketOk ? "Connected" : "Disconnected"}
        </Tag>
      </Header>

      <Content style={{ padding: 16 }}>
        <Routes>
          <Route path="/" element={<TasksPage />} />
          <Route path="/groups" element={<GroupsPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Content>
    </Layout>
  );
}


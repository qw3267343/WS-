import { useEffect, useMemo, useState } from "react";
import { Button, Card, Space, Table, Tag, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { http } from "../lib/api";
import { getSocket } from "../lib/socket";
import type { WaAccountRow } from "../lib/types";
import { loadRoles, loadSlots } from "../lib/storage";
import type { Role } from "../lib/types";

function statusColor(s: string) {
  if (s === "READY") return "green";
  if (s === "QR") return "orange";
  if (s === "AUTH_FAILURE") return "red";
  if (s === "DISCONNECTED") return "volcano";
  return "default";
}

export default function AccountsPage() {
  const slots = useMemo(() => loadSlots(), []);
  const [rows, setRows] = useState<WaAccountRow[]>([]);
  const [roles, setRoles] = useState<Role[]>(() => loadRoles());

  async function refresh() {
    const r = await http.get(`/api/accounts?slots=${encodeURIComponent(slots.join(","))}`);
    setRows(r.data.data || []);
    setRoles(loadRoles());
  }

  useEffect(() => {
    refresh();
    const s = getSocket();
    const onStatus = (p: any) => setRows(prev => prev.map(x => x.slot === p.slot ? { ...x, status: p.status } : x));
    s.on("wa:status", onStatus);
    return () => { s.off("wa:status", onStatus); };
  }, []);

  function boundRole(slot: string) {
    const r = roles.find(x => x.boundSlot === slot);
    return r ? `${r.remark}-${r.name}` : "未绑定";
  }

  const columns: ColumnsType<WaAccountRow> = [
    { title: "slot", dataIndex: "slot", width: 140 },
    { title: "状态", dataIndex: "status", width: 160, render: (v) => <Tag color={statusColor(v)}>{v}</Tag> },
    { title: "绑定角色", render: (_, r) => <Tag>{boundRole(r.slot)}</Tag> },
    {
      title: "操作",
      render: (_, r) => (
        <Space wrap>
          <Button
            type="primary"
            onClick={async () => {
              try {
                await http.post(`/api/accounts/${r.slot}/connect`);
                message.success("已触发连接/扫码");
              } catch (e: any) {
                message.error("连接失败：" + (e?.response?.data?.error || e.message));
              }
            }}
          >
            连接/扫码
          </Button>

          <Button
            danger
            onClick={async () => {
              try {
                await http.post(`/api/accounts/${r.slot}/logout`);
                message.success("已登出");
                refresh();
              } catch (e: any) {
                message.error("登出失败：" + (e?.response?.data?.error || e.message));
              }
            }}
          >
            登出
          </Button>

          <Button onClick={refresh}>刷新</Button>
        </Space>
      )
    }
  ];

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <Card title="账号池（Account Pool）" extra={<Button onClick={refresh}>刷新</Button>}>
        <Table rowKey="slot" columns={columns} dataSource={rows} pagination={false} />
      </Card>
    </div>
  );
}

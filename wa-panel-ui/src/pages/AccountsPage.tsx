import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Dropdown,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
  message
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { TableProps } from "antd/es/table";
import type { MenuProps } from "antd";
import { DownOutlined } from "@ant-design/icons";
import { http } from "../lib/api";
import { getSocket } from "../lib/socket";
import { getWsId } from "../lib/workspace";
import type { Role, WaAccountRow } from "../lib/types";
import { loadRoles } from "../lib/storage";

function statusColor(s: string) {
  if (s === "READY") return "green";
  if (s === "QR") return "orange";
  if (s === "AUTH_FAILURE") return "red";
  if (s === "DISCONNECTED") return "volcano";
  if (s === "LOGGED_OUT") return "default";
  return "default";
}

function formatUid(uid?: string | null) {
  if (!uid) return "-";
  const s = String(uid).trim();
  if (!s) return "-";
  // 纯数字（100001）直接完整显示
  if (/^\d+$/.test(s)) return s;
  // 短字符串也完整显示
  if (s.length <= 12) return s;
  // 长的截断
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

type AccRow = WaAccountRow & {
  uid?: string | null;
  phone?: string | null;
  nickname?: string | null;
};

export default function AccountsPage() {
  const [rows, setRows] = useState<AccRow[]>([]);
  const [roles, setRoles] = useState<Role[]>(() => loadRoles());
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);

  async function refresh() {
    const r = await http.get(`/api/accounts`);
    const list = (r.data.data || []) as AccRow[];

    // 没账号时显示 A1 占位
    if (!list.length) {
      setRows([{ slot: "A1", status: "NEW", lastQr: null, uid: null, phone: null, nickname: null }]);
    } else {
      setRows(list);
    }

    setRoles(loadRoles());
  }

  useEffect(() => {
    refresh();

    const s = getSocket(getWsId());
    const onStatus = (p: any) => {
      const slot = String(p?.slot || "").trim();
      if (!slot) return;

      setRows(prev => {
        const idx = prev.findIndex(x => x.slot === slot);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            status: p.status ?? next[idx].status,
            lastQr: p.lastQr ?? next[idx].lastQr,
            uid: p.uid ?? next[idx].uid ?? null,
            phone: p.phone ?? next[idx].phone ?? null,
            nickname: p.nickname ?? next[idx].nickname ?? null,
          };
          return next;
        }
        return [{ slot, status: p.status || "NEW", lastQr: null, uid: p.uid ?? null, phone: p.phone ?? null, nickname: p.nickname ?? null }, ...prev];
      });
    };

    s.on("wa:status", onStatus);
    return () => { s.off("wa:status", onStatus); };
  }, []);

  function boundRole(slot: string) {
    const r = roles.find(x => x.boundSlot === slot);
    return r ? `${r.remark}-${r.name}` : "未绑定";
  }

  async function createAccountOnly() {
    try {
      await http.post(`/api/accounts/create`);
      message.success("已新增坑位");
      await refresh();
    } catch (e: any) {
      message.error("新增失败：" + (e?.response?.data?.error || e.message));
    }
  }

  async function connect(slot: string) {
    try {
      await http.post(`/api/accounts/${slot}/connect`);
      message.success("已触发连接/扫码（等待二维码/浏览器窗口）");
    } catch (e: any) {
      message.error("连接失败：" + (e?.response?.data?.error || e.message));
    }
  }

  async function openWindow(slot: string) {
    try {
      await http.post(`/api/accounts/${slot}/open`);
      message.success("已尝试打开/置前窗口");
    } catch (e: any) {
      message.error("打开失败：" + (e?.response?.data?.error || e.message));
    }
  }

  async function logout(slot: string) {
    try {
      await http.post(`/api/accounts/${slot}/logout`);
      message.success("已登出");
      await refresh();
    } catch (e: any) {
      message.error("登出失败：" + (e?.response?.data?.error || e.message));
    }
  }

  async function deleteAccount(slot: string) {
    Modal.confirm({
      title: "删除账号",
      content: `确定删除 ${slot} 吗？（会删除本地登录缓存，之后要重新扫码）`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        try {
          await http.post(`/api/accounts/${slot}/delete`);
          message.success("已删除");
          setSelectedKeys(prev => prev.filter(k => k !== slot));
          await refresh();
        } catch (e: any) {
          message.error("删除失败：" + (e?.response?.data?.error || e.message));
        }
      }
    });
  }

  // 批量工具
  async function runBatch(slots: string[], fn: (s: string) => Promise<void>, label: string) {
    if (!slots.length) return message.warning("请先勾选账号");
    let ok = 0, fail = 0;
    for (const s of slots) {
      try { await fn(s); ok++; }
      catch { fail++; }
    }
    message.success(`${label} 完成：成功 ${ok} / 失败 ${fail}`);
    await refresh();
  }

  const selectedSlots = useMemo(() => selectedKeys.map(String), [selectedKeys]);

  const batchMenu: MenuProps = {
    items: [
      { key: "connect", label: "批量 连接/扫码" },
      { key: "logout", label: "批量 登出" },
      { type: "divider" as const },
      { key: "delete", label: "批量 删除账号", danger: true },
    ],
    onClick: async ({ key }: { key: string }) => {
      if (key === "connect") return runBatch(selectedSlots, connect, "连接/扫码");
      if (key === "logout") return runBatch(selectedSlots, logout, "登出");
      if (key === "delete") {
        Modal.confirm({
          title: "批量删除账号",
          content: `确定删除：${selectedSlots.join(", ")} 吗？（会删除本地登录缓存）`,
          okText: "删除",
          okType: "danger",
          cancelText: "取消",
          onOk: async () => {
            for (const s of selectedSlots) {
              try { await http.post(`/api/accounts/${s}/delete`); } catch {}
            }
            setSelectedKeys([]);
            await refresh();
            message.success("批量删除完成");
          }
        });
      }
    }
  };

  // 修改这里的类型定义
  const rowSelection: TableProps<AccRow>['rowSelection'] = {
    selectedRowKeys: selectedKeys,
    onChange: (keys: React.Key[]) => setSelectedKeys(keys),
    // 占位 A1 且没有 uid 的不允许勾选（可选）
    getCheckboxProps: (r) => ({
      disabled: r.status === "NEW" && !r.uid && r.slot === "A1" && rows.length === 1
    })
  };

  const columns: ColumnsType<AccRow> = [
    { title: "Slot", dataIndex: "slot", width: 90 },

    {
      title: "UID",
      dataIndex: "uid",
      width: 170,
      render: (v: any) => {
        const full = v ? String(v) : "";
        if (!full) return "-";
        return (
          <Typography.Text
            copyable={{ text: full }}
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
          >
            {formatUid(full)}
          </Typography.Text>
        );
      }
    },

    { title: "手机号码", dataIndex: "phone", width: 160, render: (v: any) => (v ? String(v) : "-") },
    { title: "昵称", dataIndex: "nickname", width: 180, render: (v: any) => (v ? String(v) : "-") },

    {
      title: "状态",
      dataIndex: "status",
      width: 120,
      render: (v: any) => <Tag color={statusColor(String(v))}>{String(v)}</Tag>
    },

    { title: "绑定角色", width: 160, render: (_, r) => <Tag>{boundRole(r.slot)}</Tag> },

    {
      title: "操作",
      width: 120,
      render: (_, r) => {
        const menu: MenuProps = {
          items: [
            { key: "connect", label: "连接/扫码" },
            { key: "open", label: "打开窗口" },
            { type: "divider" as const },
            { key: "logout", label: "登出", danger: true },
            { key: "refresh", label: "刷新" },
            { key: "delete", label: "删除账号", danger: true },
          ],
          onClick: async ({ key }: { key: string }) => {
            if (key === "connect") return connect(r.slot);
            if (key === "open") return openWindow(r.slot);
            if (key === "logout") return logout(r.slot);
            if (key === "refresh") return refresh();
            if (key === "delete") return deleteAccount(r.slot);
          }
        };

        return (
          <Dropdown menu={menu} trigger={["click"]} placement="bottomRight">
            <Button>
              打开 <DownOutlined />
            </Button>
          </Dropdown>
        );
      }
    }
  ];

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <Card
        title="账号池（Account Pool）"
        extra={
          <Space>
            <Button type="primary" onClick={createAccountOnly}>新增账号</Button>

            <Dropdown menu={batchMenu} trigger={["click"]}>
              <Button disabled={!selectedSlots.length}>
                批量操作({selectedSlots.length}) <DownOutlined />
              </Button>
            </Dropdown>

            <Button onClick={refresh}>刷新</Button>
          </Space>
        }
      >
        <Table
          rowKey="slot"
          columns={columns}
          dataSource={rows}
          rowSelection={rowSelection}
          pagination={false}
        />
      </Card>
    </div>
  );
}

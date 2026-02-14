import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Dropdown,
  Input,
  Modal,
  Progress,
  Pagination,
  Select,
  Space,
  Switch,
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
import { getWsId, wsKey } from "../lib/workspace";
import type { Role, WaAccountRow } from "../lib/types";

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
  enabled?: boolean;
  runtimeState?: string;
  state?: string;
};

type BatchResult =
  | { ok: true; slot: string }
  | { ok: false; slot: string; error: string };

export default function AccountsPage() {
  const [rows, setRows] = useState<AccRow[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [bindFilter, setBindFilter] = useState<"all" | "bound" | "unbound">("all");
  const [remarkQuery, setRemarkQuery] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchAction, setBatchAction] = useState<"connect_bound_hot" | "connect_all_verify" | "logout" | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const remarksStorageKey = wsKey("wa_accounts_remarks_v1");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(remarksStorageKey);
      const parsed = raw ? JSON.parse(raw) : {};
      setRemarks(parsed && typeof parsed === "object" ? parsed : {});
    } catch {
      setRemarks({});
    }
  }, [remarksStorageKey]);

  async function refresh() {
    const [accountsResp, rolesResp] = await Promise.all([
      http.get(`/api/accounts`),
      http.get(`/api/roles`),
    ]);
    const list = (accountsResp.data.data || []) as AccRow[];

    // 没账号时显示 A1 占位
    if (!list.length) {
      setRows([{ slot: "A1", status: "NEW", lastQr: null, uid: null, phone: null, nickname: null, enabled: true }]);
    } else {
      setRows(list);
    }

    const roleList = Array.isArray(rolesResp.data?.roles) ? (rolesResp.data.roles as Role[]) : [];
    setRoles(roleList);
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
        return [{ slot, status: p.status || "NEW", lastQr: null, uid: p.uid ?? null, phone: p.phone ?? null, nickname: p.nickname ?? null, enabled: true }, ...prev];
      });
    };

    s.on("wa:status", onStatus);
    return () => { s.off("wa:status", onStatus); };
  }, []);


  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 2000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  function boundRole(slot: string) {
    const r = roles.find(x => x.boundSlot === slot);
    return r ? `${r.remark}-${r.name}` : "未绑定";
  }

  function isBound(slot: string) {
    return roles.some(x => x.boundSlot === slot);
  }

  function commitRemark(slot: string, value: string) {
    setRemarks((prev) => {
      const next = { ...prev, [slot]: value };
      localStorage.setItem(remarksStorageKey, JSON.stringify(next));
      return next;
    });
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
    const row = rows.find((x) => x.slot === slot);
    if (row?.enabled === false) {
      message.warning("账号已停用，跳过登录");
      return;
    }
    try {
      await http.post(`/api/accounts/${slot}/connect?force=1`);
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

  const selectedSlots = useMemo(() => selectedKeys.map(String), [selectedKeys]);

  const batchMenu: MenuProps = {
    items: [
      { key: "delete", label: "批量 删除账号", danger: true },
    ],
    onClick: async ({ key }: { key: string }) => {
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
    preserveSelectedRowKeys: true,
    getCheckboxProps: (record) => ({ disabled: record.enabled === false })
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
      title: "备注",
      dataIndex: "remark",
      width: 200,
      render: (_, r) => (
        <Input
          value={remarks[r.slot] ?? ""}
          placeholder="备注..."
          onChange={(e) => {
            const v = e.target.value;
            setRemarks((prev) => ({ ...prev, [r.slot]: v }));
          }}
          onBlur={(e) => commitRemark(r.slot, e.currentTarget.value)}
          onPressEnter={(e) => commitRemark(r.slot, e.currentTarget.value)}
        />
      )
    },

    {
      title: "启用",
      dataIndex: "enabled",
      width: 90,
      render: (_: any, r) => (
        <Switch
          checked={r.enabled !== false}
          onChange={async (v) => {
            const prevEnabled = r.enabled !== false;
            setRows(prev => prev.map(item => (item.slot === r.slot ? { ...item, enabled: v } : item)));
            setSelectedKeys(prev => prev.filter(k => k !== r.slot));
            try {
              await http.post(`/api/accounts/${r.slot}/enabled`, { enabled: v });
            } catch (e: any) {
              setRows(prev => prev.map(item => (item.slot === r.slot ? { ...item, enabled: prevEnabled } : item)));
              message.error("更新启用状态失败：" + (e?.response?.data?.error || e.message));
            }
          }}
          size="small"
        />
      )
    },

    {
      title: "状态",
      dataIndex: "status",
      width: 120,
      render: (_: any, row) => {
        const state = row.runtimeState ?? row.state ?? row.status ?? "-";
        return <Tag color={statusColor(String(state))}>{String(state)}</Tag>;
      }
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

  const filteredRows = useMemo(() => {
    const query = remarkQuery.trim().toLowerCase();
    return rows.filter((row) => {
      const bound = isBound(row.slot);
      if (bindFilter === "bound" && !bound) return false;
      if (bindFilter === "unbound" && bound) return false;
      if (query) {
        const remark = (remarks[row.slot] || "").toLowerCase();
        if (!remark.includes(query)) return false;
      }
      return true;
    });
  }, [rows, bindFilter, remarkQuery, remarks, roles]);

  const total = filteredRows.length;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, maxPage);

  const start = (safePage - 1) * pageSize;
  const pageRows = filteredRows.slice(start, start + pageSize);

  useEffect(() => {
    const max = Math.max(1, Math.ceil(filteredRows.length / pageSize));
    if (page > max) setPage(max);
  }, [filteredRows.length, pageSize, page]);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <Card
        title="账号池（Account Pool）"
        extra={
          <Space>
            <Button type="primary" onClick={createAccountOnly}>新增账号</Button>

            <Button
              onClick={() => {
                setBatchAction("connect_bound_hot");
                setBatchOpen(true);
              }}
            >
              启动已绑定
            </Button>
            <Button
              disabled={!selectedSlots.length}
              onClick={() => {
                setBatchAction("connect_all_verify");
                setBatchOpen(true);
              }}
            >
              全量启动({selectedSlots.length})
            </Button>
            <Button
              disabled={!selectedSlots.length}
              onClick={() => {
                setBatchAction("logout");
                setBatchOpen(true);
              }}
            >
              一键登出({selectedSlots.length})
            </Button>

            <Dropdown menu={batchMenu} trigger={["click"]}>
              <Button disabled={!selectedSlots.length}>
                更多批量 <DownOutlined />
              </Button>
            </Dropdown>

            <Button onClick={refresh}>刷新</Button>
          </Space>
        }
      >
        <Space style={{ marginBottom: 12 }} wrap>
          <span>绑定筛选</span>
          <Select
            value={bindFilter}
            style={{ width: 140 }}
            onChange={(v) => setBindFilter(v)}
            options={[
              { value: "all", label: "全部" },
              { value: "bound", label: "已绑定" },
              { value: "unbound", label: "未绑定" },
            ]}
          />
          <Input
            value={remarkQuery}
            onChange={(e) => setRemarkQuery(e.target.value)}
            placeholder="备注关键词搜索"
            style={{ width: 220 }}
            allowClear
          />
        </Space>
        <Table
          rowKey="slot"
          columns={columns}
          dataSource={pageRows}
          rowSelection={rowSelection}
          pagination={false}
        />
        <div
          style={{
            position: "sticky",
            bottom: 0,
            zIndex: 50,
            background: "#fff",
            padding: "10px 12px",
            borderTop: "1px solid #f0f0f0",
            boxShadow: "0 -6px 16px rgba(0,0,0,0.06)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Space>
            <Button
              size="small"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <Button
              size="small"
              disabled={safePage >= maxPage}
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
            >
              下一页
            </Button>
          </Space>
          <Pagination
            current={safePage}
            pageSize={pageSize}
            total={total}
            showSizeChanger
            pageSizeOptions={["5", "10", "20", "50", "100"]}
            showTotal={(t, range) => `${range[0]}-${range[1]} / ${t}`}
            onChange={(p, ps) => {
              if (ps !== pageSize) {
                setPageSize(ps);
                setPage(1);
              } else {
                setPage(p);
              }
            }}
          />
        </div>
      </Card>

      <BatchProgressModal
        open={batchOpen}
        action={batchAction}
        slots={selectedSlots}
        rows={rows}
        roles={roles}
        onCancel={() => setBatchOpen(false)}
        onDone={async () => {
          setBatchOpen(false);
          await refresh();
        }}
      />
    </div>
  );
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  const n = Math.max(1, Math.min(concurrency || 1, 10));
  let i = 0;
  const runners = Array.from({ length: n }).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

function BatchProgressModal(props: {
  open: boolean;
  action: "connect_bound_hot" | "connect_all_verify" | "logout" | null;
  slots: string[];
  rows: AccRow[];
  roles: Role[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const [concurrency, setConcurrency] = useState<number>(2);
  const [running, setRunning] = useState(false);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [okCount, setOkCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  const [results, setResults] = useState<BatchResult[]>([]);

  useEffect(() => {
    if (props.open) {
      setRunning(false);
      setTotal(0);
      setDone(0);
      setOkCount(0);
      setFailCount(0);
      setResults([]);
    }
  }, [props.open, props.action, props.slots]);

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitReadyOrHandleAuth(slot: string, timeoutMs: number) {
    const start = Date.now();
    let lastOpenAt = 0;

    while (true) {
      const { data } = await http.get(`/api/accounts/${slot}/status`);
      const st = String(data?.status || "");
      if (st === "READY") return;

      if (st === "QR" || st === "AUTH_FAILURE") {
        if (Date.now() - lastOpenAt > 5000) {
          await http.post(`/api/accounts/${slot}/open`).catch(() => undefined);
          lastOpenAt = Date.now();
        }
      }

      if (Date.now() - start > timeoutMs) throw new Error("TIMEOUT");
      await sleep(800);
    }
  }

  async function connectAndMaybeStop(slot: string, mode: "hot" | "once", stopAfterReady: boolean) {
    await http.post(`/api/accounts/${slot}/connect?force=1`, {}, { headers: { "x-connect-mode": mode } });
    await waitReadyOrHandleAuth(slot, 10 * 60 * 1000);
    if (stopAfterReady) {
      await http.post(`/api/accounts/${slot}/stop`);
    }
  }

  async function onRun() {
    const boundSlots = new Set(
      props.roles
        .map((r) => String(r?.boundSlot || "").trim().toUpperCase())
        .filter((slot) => /^A\d+$/.test(slot))
    );

    const targets = props.action === "connect_bound_hot"
      ? props.rows.map((r) => r.slot).filter((slot) => boundSlots.has(slot))
      : props.slots;

    if (!targets.length || !props.action) {
      message.warning("没有可执行账号");
      return;
    }

    setRunning(true);
    setTotal(targets.length);
    setDone(0);
    setOkCount(0);
    setFailCount(0);
    setResults([]);

    await runPool(targets, concurrency, async (slot) => {
      try {
        const row = props.rows.find(r => r.slot === slot);
        if (row?.enabled === false) {
          setResults(prev => [...prev, { ok: true, slot }]);
          setOkCount(x => x + 1);
          return;
        }

        if (props.action === "connect_bound_hot") {
          await connectAndMaybeStop(slot, "hot", false);
        } else if (props.action === "connect_all_verify") {
          const isBound = boundSlots.has(slot);
          await connectAndMaybeStop(slot, "once", !isBound);
        } else {
          await http.post(`/api/accounts/${slot}/logout`);
          await sleep(200);
        }

        setResults(prev => [...prev, { ok: true, slot }]);
        setOkCount(x => x + 1);
      } catch (e: any) {
        setResults(prev => [
          ...prev,
          { ok: false, slot, error: String(e?.response?.data?.error || e?.message || "unknown error") },
        ]);
        setFailCount(x => x + 1);
      } finally {
        setDone(x => x + 1);
      }
    });

    const actionText = props.action === "connect_bound_hot"
      ? "启动已绑定"
      : props.action === "connect_all_verify"
        ? "全量启动"
        : "登出";
    message.success(`批量${actionText}完成`);
    setRunning(false);
    await props.onDone();
  }

  const percent = total ? Math.round((done / total) * 100) : 0;
  const title = props.action === "connect_bound_hot"
    ? "启动已绑定"
    : props.action === "connect_all_verify"
      ? "全量启动"
      : "一键登出";

  return (
    <Modal
      title={title}
      open={props.open}
      onCancel={props.onCancel}
      footer={
        <Space>
          <Button onClick={props.onCancel}>关闭</Button>
          <Button type="primary" loading={running} onClick={onRun}>
            开始执行
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Space wrap>
          <span>并发</span>
          <Select
            value={concurrency}
            style={{ width: 140 }}
            onChange={(v) => setConcurrency(Number(v))}
            options={[
              { value: 1, label: "1（串行）" },
              { value: 2, label: "2（推荐）" },
              { value: 3, label: "3（较快）" },
              { value: 4, label: "4（更快）" },
            ]}
          />
          <span style={{ marginLeft: 8 }}>已选择 {props.slots.length} 个账号</span>
        </Space>

        {total > 0 && (
          <div>
            <Progress percent={percent} />
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              总数 {total}，已完成 {done}，成功 {okCount}，失败 {failCount}
            </div>
          </div>
        )}

        {results.length > 0 && (
          <div
            style={{
              maxHeight: 240,
              overflowY: "auto",
              border: "1px solid #eee",
              borderRadius: 8,
              padding: 8,
            }}
          >
            {results.map((r, i) => (
              <div
                key={`${r.slot}-${i}`}
                style={{ padding: "6px 4px", borderBottom: "1px solid #f2f2f2" }}
              >
                {r.ok ? (
                  <span style={{ color: "green", fontWeight: 600 }}>OK</span>
                ) : (
                  <span style={{ color: "red", fontWeight: 600 }}>NO</span>
                )}
                <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.8 }}>{r.slot}</span>
                {!r.ok && (
                  <div style={{ marginTop: 4, fontSize: 13, opacity: 0.8 }}>
                    失败原因：{r.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Space>
    </Modal>
  );
}

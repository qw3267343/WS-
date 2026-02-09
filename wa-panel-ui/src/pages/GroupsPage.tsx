import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Input,
  Modal,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
  Popconfirm,
  Progress,
  Select,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { GroupTarget } from "../lib/types";
import { loadGroups, saveGroups } from "../lib/storage";
import { withWs, getWsId } from "../lib/workspace";


type ResolveResp =
  | { ok: true; data: { slot?: string; id: string; name: string } }
  | { ok: false; error?: string };


function normalizeLink(s: string) {
  const v = (s || "").trim();
  return v || undefined;
}

async function postJSON<T>(url: string, body: any): Promise<T> {
  const wsId = getWsId();
  const r = await fetch(withWs(url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ws": wsId,
    },
    body: JSON.stringify(body),
  });

  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!r.ok) {
    throw new Error(json?.error || json?.message || `HTTP ${r.status}`);
  }
  return (json ?? {}) as T;
}

export default function GroupsPage() {
  const [rows, setRows] = useState<GroupTarget[]>(() => loadGroups());
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<GroupTarget | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);

  useEffect(() => {
    saveGroups(rows);
  }, [rows]);

  const columns: ColumnsType<GroupTarget> = useMemo(
    () => [
      {
        title: "启用",
        dataIndex: "enabled",
        width: 90,
        render: (_, r) => (
          <Switch
            checked={r.enabled}
            onChange={(v) =>
              setRows((prev) =>
                prev.map((x) => (x.id === r.id ? { ...x, enabled: v } : x))
              )
            }
          />
        ),
      },
      { title: "群名", dataIndex: "name", width: 220, render: (v) => <b>{v}</b> },
      {
        title: "群ID",
        dataIndex: "id",
        width: 240,
        render: (v) => <Tag>{v}</Tag>,
      },
      { title: "备注", dataIndex: "note", ellipsis: true },
      {
        title: "来源链接",
        dataIndex: "link",
        width: 240,
        ellipsis: true,
        render: (v: string | undefined) => {
          if (!v) return <span style={{ opacity: 0.5 }}>-</span>;
          return (
            <Typography.Link href={v} target="_blank" rel="noreferrer">
              打开
            </Typography.Link>
          );
        },
      },
      {
        title: "操作",
        width: 160,
        render: (_, r) => (
          <Space>
            <Button
              size="small"
              onClick={() => {
                setEditing(r);
                setModalOpen(true);
              }}
            >
              编辑
            </Button>

            <Popconfirm
              title="确认删除这个群？"
              okText="删除"
              cancelText="取消"
              onConfirm={() =>
                setRows((prev) => prev.filter((x) => x.id !== r.id))
              }
            >
              <Button danger size="small">
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    []
  );

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <Card
        title="群（目标库）"
        extra={
          <Space>
            <Button onClick={() => setRows(loadGroups())}>刷新</Button>
            <Button
              type="primary"
              onClick={() => {
                setEditing(null);
                setModalOpen(true);
              }}
            >
              添加群
            </Button>
            <Button onClick={() => setBatchOpen(true)}>批量添加</Button>
          </Space>
        }
      >
        <Typography.Paragraph style={{ marginTop: 0, opacity: 0.75 }}>
          任务页的“对启用群发送”会读取这里 enabled=✅ 的群；禁用的不会发送。<br />
          你可以粘贴邀请链接 → 解析 → 自动填充 群ID + 群名。
        </Typography.Paragraph>

        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows}
          size="small"
          pagination={{ pageSize: 12 }}
        />
      </Card>

      <AddGroupModal
        open={modalOpen}
        editing={editing}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onOk={(g, originalId) => {
          if (!/@g\.us$/.test(g.id)) return message.error("群ID 必须以 @g.us 结尾");

          setRows((prev) => {
            let base = prev;
            if (originalId && originalId !== g.id) {
              base = prev.filter((x) => x.id !== originalId);
            }

            const idx = base.findIndex((x) => x.id === g.id);
            if (idx >= 0) {
              const next = [...base];
              next[idx] = { ...next[idx], ...g };
              return next;
            }

            return [{ ...g, enabled: true }, ...base];
          });

          setModalOpen(false);
          setEditing(null);
        }}
      />

      <BatchAddGroupsModal
        open={batchOpen}
        onCancel={() => setBatchOpen(false)}
        onAddMany={(items) => {
          setRows((prev) => {
            let next = prev.slice();
            for (const g of items) {
              if (!/@g\.us$/.test(g.id)) continue;
              const idx = next.findIndex((x) => x.id === g.id);
              if (idx >= 0) {
                next[idx] = { ...next[idx], ...g, enabled: true };
              } else {
                next = [{ ...g, enabled: true }, ...next];
              }
            }
            return next;
          });
        }}
      />
    </div>
  );
}

function AddGroupModal(props: {
  open: boolean;
  editing: GroupTarget | null;
  onCancel: () => void;
  onOk: (g: GroupTarget, originalId?: string) => void;
}) {
  const [link, setLink] = useState("");
  const [resolving, setResolving] = useState(false);

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  const originalId = props.editing?.id;

  useEffect(() => {
    if (props.open) {
      setLink(props.editing?.link || "");
      setId(props.editing?.id || "");
      setName(props.editing?.name || "");
      setNote(props.editing?.note || "");
      setResolving(false);
    }
  }, [props.open, props.editing]);

  async function onResolve() {
    const v = link.trim();
    if (!v) {
      message.error("请先粘贴群邀请链接");
      return;
    }

    setResolving(true);
    try {
      const r = await postJSON<ResolveResp>("/api/groups/resolve", {
        link: v,
        join: true,
      });

      if (!r.ok) {
        throw new Error(r.error || "解析失败");
      }

      const gid = (r.data?.id || "").trim();
      const gname = (r.data?.name || "").trim();

      if (gid) {
        setId(gid);
      }
      if (gname) {
        setName(gname);
      }

      const slotInfo = r.data?.slot ? `（${r.data.slot}）` : "";
      message.success(`解析成功${slotInfo}：${gname || "群名未知"}`);
    } catch (e: any) {
      message.error("解析失败：" + (e?.message || "unknown error"));
    } finally {
      setResolving(false);
    }
  }

  const isEdit = !!props.editing;

  return (
    <Modal
      title={isEdit ? "编辑群" : "添加群"}
      open={props.open}
      onCancel={props.onCancel}
      okText="保存"
      cancelText="取消"
      onOk={() => {
        const gid = id.trim();
        const gname = name.trim();
        if (!gid) return message.error("群ID不能为空");
        if (!/@g\.us$/.test(gid)) return message.error("群ID 必须以 @g.us 结尾");
        if (!gname) return message.error("群名不能为空");

        props.onOk(
          {
            id: gid,
            name: gname,
            enabled: true,
            note: note.trim() || undefined,
            link: normalizeLink(link),
            tags: props.editing?.tags || [],
          },
          originalId
        );
      }}
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <div>
          <Typography.Text>群邀请链接（可选）</Typography.Text>
          <Input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://chat.whatsapp.com/xxxxxxxxxxxxxx"
            onPressEnter={() => {
              if (link.trim() && !resolving) onResolve();
            }}
          />
          <div style={{ marginTop: 8 }}>
            <Button block onClick={onResolve} loading={resolving} disabled={!link.trim()}>
              解析链接
            </Button>
          </div>
        </div>

        <div>
          <Typography.Text>群ID（唯一键 xxx@g.us）</Typography.Text>
          <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="12345@g.us" />
        </div>

        <div>
          <Typography.Text>群名（显示用）</Typography.Text>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <Typography.Text>备注（可选）</Typography.Text>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </Space>
    </Modal>
  );
}

type BatchResult =
  | { ok: true; link: string; id: string; name: string }
  | { ok: false; link: string; error: string };

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

function BatchAddGroupsModal(props: {
  open: boolean;
  onCancel: () => void;
  onAddMany: (items: GroupTarget[]) => void;
}) {
  const [text, setText] = useState("");
  const [join, setJoin] = useState(true);
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
  }, [props.open]);

  async function onRun() {
    const lines = text
      .split(/\r?\n/g)
      .map((s) => s.trim())
      .filter(Boolean);

    if (!lines.length) return message.error("请粘贴群邀请链接（每行一条）");

    setRunning(true);
    setTotal(lines.length);
    setDone(0);
    setOkCount(0);
    setFailCount(0);
    setResults([]);

    const out: GroupTarget[] = [];

    await runPool(lines, concurrency, async (link) => {
      try {
        const r = await postJSON<ResolveResp>("/api/groups/resolve", {
          link,
          join,
        });
        if (!r.ok) throw new Error(r.error || "解析失败");

        const gid = (r.data?.id || "").trim();
        const gname = (r.data?.name || "").trim();
        if (!gid) throw new Error("解析不到群ID");

        out.push({
          id: gid,
          name: gname || gid,
          enabled: true,
          link: normalizeLink(link),
          note: undefined,
          tags: [],
        });

        setResults((prev) => [
          ...prev,
          { ok: true, link, id: gid, name: gname || gid },
        ]);
        setOkCount((x) => x + 1);
      } catch (e: any) {
        setResults((prev) => [
          ...prev,
          { ok: false, link, error: String(e?.message || e || "unknown error") },
        ]);
        setFailCount((x) => x + 1);
      } finally {
        setDone((x) => x + 1);
      }
    });

    if (out.length) {
      props.onAddMany(out);
      message.success(`已写入 ${out.length} 条群记录`);
    } else {
      message.warning("没有成功解析的群");
    }

    setRunning(false);
  }

  const percent = total ? Math.round((done / total) * 100) : 0;

  return (
    <Modal
      title="批量添加群"
      open={props.open}
      onCancel={props.onCancel}
      footer={
        <Space>
          <Button onClick={props.onCancel}>关闭</Button>
          <Button type="primary" loading={running} onClick={onRun}>
            解析并写入
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <div>
          <Typography.Text>群邀请链接（每行一条）</Typography.Text>
          <Input.TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "https://chat.whatsapp.com/xxxx...\nhttps://chat.whatsapp.com/yyyy...\n..."
            }
            autoSize={{ minRows: 6, maxRows: 12 }}
          />
        </div>

        <Space wrap>
          <span>并发</span>
          <Select
            value={concurrency}
            style={{ width: 120 }}
            onChange={(v) => setConcurrency(Number(v))}
            options={[
              { value: 1, label: "1（串行）" },
              { value: 2, label: "2（推荐）" },
              { value: 3, label: "3（较快）" },
              { value: 4, label: "4（更快）" },
            ]}
          />
          <span style={{ marginLeft: 8 }}>自动入群</span>
          <Switch checked={join} onChange={setJoin} />
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
                key={i}
                style={{ padding: "6px 4px", borderBottom: "1px solid #f2f2f2" }}
              >
                {r.ok ? (
                  <span style={{ color: "green", fontWeight: 600 }}>OK</span>
                ) : (
                  <span style={{ color: "red", fontWeight: 600 }}>NO</span>
                )}
                <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.8 }}>
                  {r.link}
                </span>
                <div style={{ marginTop: 4, fontSize: 13 }}>
                  {r.ok ? (
                    <span>{r.name}</span>
                  ) : (
                    <span style={{ opacity: 0.8 }}>失败原因：{r.error}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Space>
    </Modal>
  );
}

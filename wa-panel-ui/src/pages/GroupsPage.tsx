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
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { GroupTarget } from "../lib/types";
import { loadGroups, saveGroups } from "../lib/storage";
import { http } from "../lib/api";


type ResolveResp =
  | { ok: true; data: { slot?: string; id: string; name: string } }
  | { ok: false; error?: string };


function normalizeLink(s: string) {
  const v = (s || "").trim();
  return v || undefined;
}

export default function GroupsPage() {
  const [rows, setRows] = useState<GroupTarget[]>(() => loadGroups());
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<GroupTarget | null>(null);

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
    const resp = await http.post<ResolveResp>("/api/groups/resolve", {
      link: v,
      join: true
    });

    const r = resp.data;
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
    message.error("解析失败：" + (e?.response?.data?.error || e?.message || "unknown error"));
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

import { useEffect, useState } from "react";
import { Button, Card, Input, Modal, Space, Switch, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { GroupTarget } from "../lib/types";
import { loadGroups, saveGroups, uid } from "../lib/storage";

export default function GroupsPage() {
  const [rows, setRows] = useState<GroupTarget[]>(() => loadGroups());
  const [modal, setModal] = useState(false);

  useEffect(() => {
    saveGroups(rows);
  }, [rows]);

  const columns: ColumnsType<GroupTarget> = [
    {
      title: "启用",
      dataIndex: "enabled",
      width: 90,
      render: (_, r) => (
        <Switch
          checked={r.enabled}
          onChange={(v) => setRows(prev => prev.map(x => x.id === r.id ? { ...x, enabled: v } : x))}
        />
      )
    },
    { title: "群名", dataIndex: "name", width: 220, render: (v) => <b>{v}</b> },
    {
      title: "群ID",
      dataIndex: "id",
      render: (v) => <Tag>{v}</Tag>
    },
    { title: "备注", dataIndex: "note" },
    {
      title: "操作",
      width: 120,
      render: (_, r) => (
        <Space>
          <Button
            danger
            size="small"
            onClick={() => setRows(prev => prev.filter(x => x.id !== r.id))}
          >
            删除
          </Button>
        </Space>
      )
    }
  ];

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <Card
        title="群（目标库）"
        extra={
          <Space>
            <Button onClick={() => setRows(loadGroups())}>刷新</Button>
            <Button type="primary" onClick={() => setModal(true)}>添加群</Button>
          </Space>
        }
      >
        <Typography.Paragraph style={{ marginTop: 0, opacity: 0.75 }}>
          任务页的“对启用群发送”会读取这里 enabled=✅ 的群；禁用的不会发送。<br/>
          v1 先支持手动添加（你也可以稍后让我给后端加“从账号同步群列表”）。
        </Typography.Paragraph>

        <Table rowKey="id" columns={columns} dataSource={rows} pagination={{ pageSize: 12 }} />
      </Card>

      <AddGroupModal
        open={modal}
        onCancel={() => setModal(false)}
        onOk={(g) => {
          if (!/@g\.us$/.test(g.id)) return message.error("群ID 必须以 @g.us 结尾");
          setRows(prev => {
            if (prev.find(x => x.id === g.id)) return prev.map(x => x.id === g.id ? { ...x, ...g } : x);
            return [{ ...g, enabled: true }, ...prev];
          });
          setModal(false);
        }}
      />
    </div>
  );
}

function AddGroupModal(props: {
  open: boolean;
  onCancel: () => void;
  onOk: (g: GroupTarget) => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (props.open) {
      setId("");
      setName("");
      setNote("");
    }
  }, [props.open]);

  return (
    <Modal
      title="添加群"
      open={props.open}
      onCancel={props.onCancel}
      onOk={() => {
        if (!id.trim()) return message.error("群ID不能为空");
        if (!name.trim()) return message.error("群名不能为空");
        props.onOk({ id: id.trim(), name: name.trim(), enabled: true, note: note.trim() || undefined, tags: [], });
      }}
      okText="保存"
      cancelText="取消"
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <div>
          <Typography.Text>群ID（唯一，形如 12345@g.us）</Typography.Text>
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

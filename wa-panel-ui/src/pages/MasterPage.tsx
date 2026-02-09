import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Form,
  Input,
  Layout,
  Modal,
  Popconfirm,
  Space,
  Table,
  Typography,
  message,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { http } from "../lib/api";

const { Header, Content } = Layout;

type ProjectRow = {
  id: string;
  name: string;
  note?: string;
  accountsCount?: number;
  groupsCount?: number;
  createdAt?: string;
  updatedAt?: string;
};

type ProjectFormValues = {
  name: string;
  note?: string;
};

export default function MasterPage() {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSaving, setModalSaving] = useState(false);
  const [editing, setEditing] = useState<ProjectRow | null>(null);
  const [form] = Form.useForm<ProjectFormValues>();

  const titleText = useMemo(() => (editing ? "编辑任务" : "新建任务"), [editing]);

  async function fetchProjects() {
    setLoading(true);
    try {
      const res = await http.get("/api/projects");
      setRows(res.data?.data || []);
    } catch (e) {
      message.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchProjects();
  }, []);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (row: ProjectRow) => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      note: row.note || "",
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setModalSaving(true);
      if (editing) {
        await http.put(`/api/projects/${editing.id}`, values);
        message.success("任务已更新");
      } else {
        await http.post("/api/projects", values);
        message.success("任务已创建");
      }
      setModalOpen(false);
      await fetchProjects();
    } catch (e) {
      if (e && (e as { errorFields?: unknown }).errorFields) return;
      message.error(String(e));
    } finally {
      setModalSaving(false);
    }
  };

  const handleDelete = async (row: ProjectRow) => {
    try {
      await http.delete(`/api/projects/${row.id}`);
      message.success("任务已删除");
      await fetchProjects();
    } catch (e) {
      message.error(String(e));
    }
  };

  const handleOpen = (row: ProjectRow) => {
    window.open(`/w/${row.id}`, "_blank", "popup,width=1200,height=800");
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Header style={{ background: "#0b1d2a", display: "flex", alignItems: "center", gap: 16 }}>
        <Typography.Title level={4} style={{ margin: 0, color: "#fff", minWidth: 140 }}>
          WA Master
        </Typography.Title>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建任务
          </Button>
          <Button icon={<ReloadOutlined />} onClick={fetchProjects}>
            刷新
          </Button>
        </Space>
      </Header>
      <Content style={{ padding: 16 }}>
        <Table<ProjectRow>
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: "任务名字", dataIndex: "name", key: "name" },
            { title: "任务备注", dataIndex: "note", key: "note" },
            { title: "账号数量", dataIndex: "accountsCount", key: "accountsCount", width: 120 },
            { title: "群聊数量", dataIndex: "groupsCount", key: "groupsCount", width: 120 },
            {
              title: "操作",
              key: "actions",
              width: 220,
              render: (_, row) => (
                <Space>
                  <Button size="small" type="primary" onClick={() => handleOpen(row)}>
                    打开
                  </Button>
                  <Button size="small" onClick={() => openEdit(row)}>
                    编辑
                  </Button>
                  <Popconfirm title="确认删除该任务？" onConfirm={() => handleDelete(row)}>
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Content>
      <Modal
        open={modalOpen}
        title={titleText}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        confirmLoading={modalSaving}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="任务名字"
            rules={[{ required: true, message: "请输入任务名字" }]}
          >
            <Input placeholder="请输入任务名字" />
          </Form.Item>
          <Form.Item name="note" label="任务备注">
            <Input.TextArea placeholder="请输入任务备注" rows={4} />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
}

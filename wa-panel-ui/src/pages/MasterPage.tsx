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
import { useNavigate } from "react-router-dom";
import { http } from "../lib/api";
import { clearAuth } from "../lib/auth";
import { requestWithRetry, isNetErr } from "../lib/retry";

const { Header, Content } = Layout;

type ProjectRow = {
  id: string;
  name: string;
  note?: string;
  accountCount?: number;
  groupCount?: number;
  createdAt?: string;
  updatedAt?: string;
};

type ProjectFormValues = {
  name: string;
  note?: string;
};

export default function MasterPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSaving, setModalSaving] = useState(false);
  const [editing, setEditing] = useState<ProjectRow | null>(null);
  const [form] = Form.useForm<ProjectFormValues>();

  const titleText = useMemo(() => (editing ? "编辑任务" : "新建任务"), [editing]);

  // ✅ 新增通用打开函数
  function openProjectWindow(projectId: string) {
    const w: any = window as any;

    // Electron 环境：走 IPC 打开新窗口（需确保 preload 暴露了 ws.openProjectWindow）
    if (w?.ws?.openProjectWindow) {
      return w.ws.openProjectWindow(projectId);
    }

    // 浏览器环境：新开标签页，保留 hash 路由结构
    const hash = `#/project?ws=${encodeURIComponent(projectId)}`;
    const base = window.location.href.split("#")[0]; // 兼容 file:// 和 http://
    const url = `${base}${hash}`;
    window.open(url, "_blank");
    return Promise.resolve();
  }

  async function loadProjects() {
    setLoading(true);
    try {
      const res = await requestWithRetry(() => http.get("/api/projects"), {
        retries: 10,
        baseDelayMs: 400,
        maxDelayMs: 2000,
      });
      setRows(res.data?.data || []);
    } catch (e: any) {
      // ✅ 启动阶段网关未就绪：静默，不弹红色报错
      if (!isNetErr(e)) message.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProjects();
    const timer = window.setInterval(() => {
      loadProjects();
    }, 3000);
    return () => window.clearInterval(timer);
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
        setModalOpen(false);
        await loadProjects();
      } else {
        await http.post("/api/projects", values);
        message.success("任务已创建");
        setModalOpen(false);
        await loadProjects();
      }
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
      await loadProjects();
    } catch (e) {
      message.error(String(e));
    }
  };

  const handleStart = async (row: ProjectRow) => {
    try {
      await http.post(`/api/projects/${row.id}/start`);
      message.success("任务已启动");
      await loadProjects();
      await openProjectWindow(row.id);
    } catch (e) {
      message.error(String(e));
    }
  };

  const handleStop = async (row: ProjectRow) => {
    try {
      await http.post(`/api/projects/${row.id}/stop`);
      message.success("任务已停止");
      await loadProjects();
    } catch (e) {
      message.error(String(e));
    }
  };


  const handleLogout = () => {
    clearAuth();
    navigate("/login", { replace: true });
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
          <Button icon={<ReloadOutlined />} onClick={loadProjects}>
            刷新
          </Button>
          <Button danger onClick={handleLogout}>
            退出
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
            { title: "任务ID", dataIndex: "id", key: "id", width: 160 },
            { title: "任务名字", dataIndex: "name", key: "name" },
            { title: "任务备注", dataIndex: "note", key: "note" },
            { title: "账号数量", dataIndex: "accountCount", key: "accountCount", width: 120 },
            { title: "群聊数量", dataIndex: "groupCount", key: "groupCount", width: 120 },
            {
              title: "操作",
              key: "actions",
              width: 220,
              render: (_, row) => (
                <Space>
                  <Button size="small" type="primary" onClick={() => handleStart(row)}>
                    启动
                  </Button>
                  <Button size="small" onClick={() => handleStop(row)}>
                    停止
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
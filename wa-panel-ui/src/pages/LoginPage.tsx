import { Button, Card, Form, Input, Typography, message } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { saveAuth } from "../lib/auth";
import { http } from "../lib/api";

type LoginForm = {
  username: string;
  password: string;
};

type LoginResponse = {
  access_token: string;
  refresh_token: string;
  expires_in_sec: number;
};

export default function LoginPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (values: LoginForm) => {
    try {
      setLoading(true);

      const r = await http.post("/api/auth/login", {
        username: values.username,
        password: values.password,
        device_id: null,
      });

      const data = r.data as LoginResponse;

      if (!data?.access_token || !data?.refresh_token) {
        throw new Error("invalid login response");
      }

      saveAuth(data);
      message.success("登录成功");
      navigate("/", { replace: true });
    } catch (e: any) {
      message.error("登录失败，请检查用户名和密码后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f7fa",
        padding: 24,
      }}
    >
      <Card style={{ width: 380 }}>
        <Typography.Title level={3} style={{ textAlign: "center", marginBottom: 24 }}>
          WA 面板登录
        </Typography.Title>

        <Form<LoginForm> layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input placeholder="请输入用户名" autoComplete="username" />
          </Form.Item>

          <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password placeholder="请输入密码" autoComplete="current-password" />
          </Form.Item>

          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
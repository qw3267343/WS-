import { Button, Card, Input, Space, Typography, message } from "antd";
import { useState } from "react";
import { setApiBase } from "../lib/api";
import { resetSocket } from "../lib/socket";
import { saveSlots } from "../lib/storage";

export default function SettingsPage() {
  const [api, setApi] = useState(localStorage.getItem("wa_api_base") || "http://127.0.0.1:3001");
  const [slots, setSlots] = useState(localStorage.getItem("wa_slots_v1") || "acc001,acc002,acc003");

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <Card title="设置">
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <div>
            <Typography.Text>后端地址（API_BASE）</Typography.Text>
            <Input value={api} onChange={(e) => setApi(e.target.value)} />
          </div>

          <div>
            <Typography.Text>slot 列表（逗号分隔）</Typography.Text>
            <Input value={slots} onChange={(e) => setSlots(e.target.value)} />
          </div>

          <Space>
            <Button
              type="primary"
              onClick={() => {
                setApiBase(api.trim());
                saveSlots(slots.trim());
                resetSocket();
                message.success("已保存。建议刷新页面生效。");
              }}
            >
              保存
            </Button>
            <Button onClick={() => window.location.reload()}>刷新页面</Button>
          </Space>

          <Typography.Paragraph style={{ opacity: 0.75, marginBottom: 0 }}>
            v1 数据存档：角色/群/slots 都存浏览器 LocalStorage。后续可改成后端 JSON/SQLite 持久化。
          </Typography.Paragraph>
        </Space>
      </Card>
    </div>
  );
}

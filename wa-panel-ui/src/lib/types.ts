export type Role = {
  id: string;
  remark: string;     // 老师/助理/老手1…
  name: string;       // 显示名
  boundSlot?: string; // acc002…
};

export type GroupTarget = {
  id: string;        // 12345@g.us
  name: string;      // 群名（可变）
  enabled: boolean;  // 启用/禁用
  link?: string;
  note?: string;
  tags?: string[];
};

export type WaAccountRow = {
  slot: string;
  status: string;
  lastQr?: string | null;
};

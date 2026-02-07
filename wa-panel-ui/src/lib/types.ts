// wa-panel-ui/src/lib/types.ts  （整文件覆盖）

export type Role = {
  id: string;
  remark: string;     // 老师/助理/老手1…
  name: string;       // 显示名
  boundSlot?: string; // A1/A2…
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
  uid?: string | null;

  status: string;
  lastQr?: string | null;

  phone?: string | null;
  nickname?: string | null;
};

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AutoComplete,
  Button,
  Card,
  Col,
  Dropdown,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  Typography,
  message
} from "antd";
import type { MenuProps } from "antd";
import { MoreOutlined, PlusOutlined, ReloadOutlined, DeleteOutlined, DragOutlined, CloseOutlined } from "@ant-design/icons";
import { http } from "../lib/api";
import { getSocket } from "../lib/socket";
import { getWsId, wsKey } from "../lib/workspace";
import type { GroupTarget, Role, WaAccountRow } from "../lib/types";
import { loadGroups, loadRoles, saveRoles, uid } from "../lib/storage";

const K_HIS = "wa_send_history_v2";
type HisItem = {
  id: string;
  ts: number;
  lastTs?: number;

  kind: "single" | "batch";

  roleRemark: string;
  roleName: string;
  slot?: string;

  mode: "enabled_groups" | "single_group" | "single_contact";

  // 不再需要展示 to/toName
  to?: string;
  toName?: string;

  text: string;

  // ✅ 最终状态：OK(true)/NO(false)
  ok: boolean;

  // ✅ 批次发送中
  running?: boolean;

  // ✅ 批次统计
  total?: number;
  okCount?: number;
  failCount?: number;

  // ✅ 失败时显示一个简短原因（不展示群信息）
  lastErr?: string;

  media?: { name: string; type: string; size: number }[];
};

type ScheduledJob = {
  id: string;
  runAt: number;
  slot: string;
  mode: "enabled_groups" | "single_group" | "single_contact";
  targets: string[];
  text: string;
  status: "pending" | "running" | "done" | "cancelled";
  createdAt?: number;
  startedAt?: number;
  finishedAt?: number;
  result?: {
    total: number;
    okCount: number;
    failCount: number;
    lastErr?: string | null;
  };
  attachments?: { id: string; name: string; type: string; path: string }[];
  ws?: string;
  lastErr?: string;
};

function loadHis(): HisItem[] {
  try { return JSON.parse(localStorage.getItem(wsKey(K_HIS)) || "[]"); } catch { return []; }
}
function saveHis(arr: HisItem[]) {
  localStorage.setItem(wsKey(K_HIS), JSON.stringify(arr.slice(-500)));
}
function fmtTime(ts: number) {
  const d = new Date(ts);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
function statusColor(s: string) {
  if (s === "READY") return "green";
  if (s === "QR") return "orange";
  if (s === "AUTH_FAILURE") return "red";
  if (s === "DISCONNECTED") return "volcano";
  if (s === "LOGGED_OUT") return "default";
  return "default";
}
function humanSize(n: number) {
  const kb = 1024, mb = kb * 1024;
  if (n >= mb) return (n / mb).toFixed(1) + "MB";
  if (n >= kb) return (n / kb).toFixed(1) + "KB";
  return n + "B";
}


type AccRow = WaAccountRow & {
  phone?: string | null;
  nickname?: string | null;
  uid?: string | null;
};

export default function TasksPage() {
  const PAGE_H = "calc(100vh - 64px - 32px)";
  const BASE_INPUT_AREA_H = 240;
  const MEDIA_INPUT_AREA_H = 340;
  const SEND_CONCURRENCY = 4;

  function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async function runPool<T>(
    items: T[],
    worker: (item: T, index: number) => Promise<boolean>,
    concurrency: number
  ) {
    let idx = 0;
    const results: boolean[] = new Array(items.length).fill(false);

    const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) break;
        results[i] = await worker(items[i], i);
      }
    });

    await Promise.all(runners);
    return results;
  }

  const [accounts, setAccounts] = useState<AccRow[]>([]);
  const [roles, setRoles] = useState<Role[]>(() => loadRoles());
  const [groups, setGroups] = useState<GroupTarget[]>(() => loadGroups());
  const [activeRoleId, setActiveRoleId] = useState<string | null>(roles[0]?.id || null);

  const [mode, setMode] = useState<"enabled_groups" | "single_group" | "single_contact">("enabled_groups");
  const [singleTo, setSingleTo] = useState("");
  const [text, setText] = useState("");
  const [inputAreaH, setInputAreaH] = useState(BASE_INPUT_AREA_H);

  const [runIdx, setRunIdx] = useState(0);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const enabledGroups = useMemo(() => groups.filter(g => g.enabled), [groups]);
  const nextGroup = enabledGroups[runIdx] || null;

  const [history, setHistory] = useState<HisItem[]>(() => loadHis());
  const hisBottomRef = useRef<HTMLDivElement>(null);

  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJob[]>([]);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleMinutes, setScheduleMinutes] = useState(5);
  const [nowTs, setNowTs] = useState(Date.now());

  // 角色编辑弹窗
  const [roleModal, setRoleModal] = useState<{ open: boolean; editing?: Role | null }>({ open: false });

  // ✅ 绑定/替换账号弹窗（新）
  const [bindModal, setBindModal] = useState<{ open: boolean; role: Role | null }>({ open: false, role: null });
  const [bindSlot, setBindSlot] = useState<string>("");

  // 媒体附件（图片/视频）
  const [files, setFiles] = useState<File[]>([]);
  const previews = useMemo(() => {
    return files.map(f => {
      const key = `${f.name}_${f.size}_${f.lastModified}`;
      const isImg = (f.type || "").startsWith("image/");
      const url = isImg ? URL.createObjectURL(f) : "";
      return { key, file: f, isImg, url };
    });
  }, [files]);
  useEffect(() => {
    return () => {
      previews.forEach(p => { if (p.url) URL.revokeObjectURL(p.url); });
    };
  }, [previews]);

  const filePickRef = useRef<HTMLInputElement>(null);
  const textAreaRef = useRef<any>(null);

  useLayoutEffect(() => {
    setInputAreaH(files.length > 0 ? MEDIA_INPUT_AREA_H : BASE_INPUT_AREA_H);
  }, [files.length]);

  const onDropFiles = (e: React.DragEvent) => {
    e.preventDefault();
    const list = Array.from(e.dataTransfer.files || []);
    const picked = list.filter(f => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (picked.length) addFiles(picked);
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    const picked = list.filter(f => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (picked.length) addFiles(picked);
    e.currentTarget.value = "";
  };

  const roleMap = useMemo(() => new Map(roles.map(r => [r.id, r])), [roles]);
  const activeRole = activeRoleId ? roleMap.get(activeRoleId) : null;

  const groupOptions = useMemo(() => {
    return groups.map(g => ({
      value: g.id,
      label: `${g.name}  (${g.id})${g.enabled ? "" : "  [禁用]"}`
    }));
  }, [groups]);

  // 拖拽相关状态
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingOverId, setDraggingOverId] = useState<string | null>(null);

  // 开始拖拽
  const handleDragStart = (e: React.DragEvent, roleId: string) => {
    e.dataTransfer.setData("text/plain", roleId);
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(roleId);
  };
  // 拖拽经过
  const handleDragOver = (e: React.DragEvent, roleId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (roleId !== draggingOverId) setDraggingOverId(roleId);
  };
  // 拖拽离开
  const handleDragLeave = () => setDraggingOverId(null);
  // 放置
  const handleDrop = (e: React.DragEvent, targetRoleId: string) => {
    e.preventDefault();
    const draggedRoleId = e.dataTransfer.getData("text/plain");

    if (draggedRoleId === targetRoleId) {
      setDraggingId(null);
      setDraggingOverId(null);
      return;
    }

    const draggedIndex = roles.findIndex(r => r.id === draggedRoleId);
    const targetIndex = roles.findIndex(r => r.id === targetRoleId);

    if (draggedIndex !== -1 && targetIndex !== -1) {
      const newRoles = [...roles];
      const [draggedRole] = newRoles.splice(draggedIndex, 1);
      newRoles.splice(targetIndex, 0, draggedRole);
      setRoles(newRoles);
      saveRoles(newRoles);
      message.success("角色顺序已调整");
    }

    setDraggingId(null);
    setDraggingOverId(null);
  };
  // 拖拽结束
  const handleDragEnd = () => {
    setDraggingId(null);
    setDraggingOverId(null);
  };

  // ✅ 动态账号：直接拉 /api/accounts
  async function refreshAccounts() {
    const r = await http.get(`/api/accounts`);
    const list = (r.data?.data || []) as AccRow[];

    // 没账号：给一个 A1 占位（方便先绑定）
    if (!list.length) {
      setAccounts([{ slot: "A1", status: "NEW", lastQr: null, phone: null, nickname: null, uid: null }]);
      return;
    }
    setAccounts(list);
  }

  function slotLabel(a: AccRow) {
    const phone = a.phone ? ` · ${a.phone}` : "";
    const nick = a.nickname ? ` · ${a.nickname}` : "";
    return `${a.slot}${phone}${nick}`;
  }

  function nicknameOfSlot(slot: string) {
    const a = accounts.find(x => x.slot === slot);
    return (a?.nickname as any) || (a as any)?.pushname || (a as any)?.pushName || null;
  }

  async function refreshRoleNicknames() {
    // 用 accounts 里的 nickname 直接补
    setRoles(prev => prev.map(r => {
      if (!r.boundSlot) return r;
      const nm = nicknameOfSlot(r.boundSlot);
      if (!nm) return r;
      if (r.name && r.name !== "未知") return r; // 不强行覆盖你手改过的
      return { ...r, name: nm || "未知" };
    }));
  }

  async function syncNicknameForSlot(slot: string) {
    let nm = nicknameOfSlot(slot);
    if (!nm) {
      await refreshAccounts();
      nm = nicknameOfSlot(slot);
    }
    const name = nm || "未知";
    setRoles(prev => prev.map(r => r.boundSlot === slot ? { ...r, name } : r));
  }

  useEffect(() => {
    (async () => {
      await refreshAccounts();
      await refreshRoleNicknames();
    })();

    const s = getSocket(getWsId());
    const onStatus = (p: any) => {
      const slot = String(p?.slot || "").trim();
      if (!slot) return;

      setAccounts(prev => {
        const idx = prev.findIndex(x => x.slot === slot);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            status: p.status ?? next[idx].status,
            phone: p.phone ?? next[idx].phone ?? null,
            nickname: p.nickname ?? next[idx].nickname ?? null,
            uid: p.uid ?? next[idx].uid ?? null,
          };
          return next;
        }
        return [{ slot, status: p.status || "NEW", phone: p.phone ?? null, nickname: p.nickname ?? null, uid: p.uid ?? null }, ...prev];
      });
    };
    s.on("wa:status", onStatus);
    return () => { s.off("wa:status", onStatus); };
  }, []);

  useEffect(() => {
    saveRoles(roles);
    if (activeRoleId && !roles.find(r => r.id === activeRoleId)) {
      setActiveRoleId(roles[0]?.id || null);
    }
  }, [roles]);

  useEffect(() => {
    hisBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length]);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const r = await http.get("/api/schedules");
        if (!alive) return;
        const list = (r.data?.data || []) as ScheduledJob[];
        setScheduledJobs(list);
      } catch {
        if (!alive) return;
        setScheduledJobs([]);
      }
    };

    void refresh();
    const timer = setInterval(() => {
      setNowTs(Date.now());
      void refresh();
    }, 2000);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  function getAccText(slot?: string) {
    if (!slot) return { text: "未绑定", color: "default" as const };
    const a = accounts.find(x => x.slot === slot);
    const s = a?.status || "UNKNOWN";
    return { text: `${slot}/${s}`, color: statusColor(s) as any };
  }

  function pushHistory(item: HisItem) {
    setHistory(prev => {
      const next = [...prev, item].slice(-500);
      saveHis(next);
      return next;
    });
  }

  function patchHistory(id: string, updater: (h: HisItem) => HisItem) {
    setHistory(prev => {
      const next = prev.map(h => (h.id === id ? updater(h) : h));
      saveHis(next);
      return next;
    });
  }

  function newId() {
    return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function startBatchHistory(batchId: string, total: number) {
    if (!activeRole?.boundSlot) return;

    const mediaMeta = files.map(f => ({ name: f.name, type: f.type || "unknown", size: f.size }));

    pushHistory({
      id: batchId,
      ts: Date.now(),
      lastTs: Date.now(),
      kind: "batch",
      roleRemark: activeRole.remark,
      roleName: activeRole.name || "未知",
      slot: activeRole.boundSlot,
      mode: "enabled_groups",
      text,
      ok: false,
      running: true,
      total,
      okCount: 0,
      failCount: 0,
      media: mediaMeta.length ? mediaMeta : undefined
    });
  }

  function finalizeBatchHistory(batchId: string) {
    patchHistory(batchId, h => {
      const okCount = h.okCount || 0;
      const failCount = h.failCount || 0;
      const total = h.total || (okCount + failCount);
      return {
        ...h,
        total,
        running: false,
        ok: failCount === 0 && (okCount + failCount) >= total,
        lastTs: Date.now()
      };
    });
  }

  function addFiles(list: File[]) {
    if (!list.length) return;
    const merged = [...files, ...list];
    const next = merged.slice(0, 8);
    setFiles(next);
    message.success(`已添加附件：${list.length} 个（总 ${next.length}）`);
  }

  function onPasteFiles(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const got: File[] = [];
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) got.push(f);
      }
    }
    if (got.length) {
      e.preventDefault();
      addFiles(got);
    }
  }

  async function connectSlot(slot: string) {
    try {
      await http.post(`/api/accounts/${slot}/connect`);
      message.success("已触发连接/扫码（等待二维码）");
    } catch (e: any) {
      message.error("连接失败：" + (e?.response?.data?.error || e.message));
    }
  }

  async function sendText(slot: string, to: string) {
    await http.post(`/api/accounts/${slot}/send`, { to, text });
  }

  async function sendMedia(slot: string, to: string) {
    const fd = new FormData();
    fd.append("to", to);
    fd.append("caption", text || "");
    files.forEach(f => fd.append("files", f, f.name));
    await http.post(`/api/accounts/${slot}/sendMedia`, fd);
  }

  async function sendOne(to: string, opt?: { batchId?: string }) {
    if (!activeRole?.boundSlot) {
      message.error("该角色未绑定账号，请先绑定账号");
      return false;
    }
    const slot = activeRole.boundSlot;

    const mediaMeta = files.map(f => ({ name: f.name, type: f.type || "unknown", size: f.size }));

    try {
      if (files.length) await sendMedia(slot, to);
      else await sendText(slot, to);

      if (opt?.batchId) {
        patchHistory(opt.batchId, h => {
          const okCount = (h.okCount || 0) + 1;
          const failCount = h.failCount || 0;
          return {
            ...h,
            okCount,
            failCount,
            lastTs: Date.now(),
            ok: false
          };
        });
        return true;
      }

      pushHistory({
        id: newId(),
        ts: Date.now(),
        lastTs: Date.now(),
        kind: "single",
        roleRemark: activeRole.remark,
        roleName: activeRole.name || "未知",
        slot,
        mode,
        to,
        text,
        ok: true,
        media: mediaMeta.length ? mediaMeta : undefined
      });

      return true;
    } catch (e: any) {
      const err = e?.response?.data?.error || e.message;

      if (opt?.batchId) {
        patchHistory(opt.batchId, h => {
          const okCount = h.okCount || 0;
          const failCount = (h.failCount || 0) + 1;
          return {
            ...h,
            okCount,
            failCount,
            lastErr: err,
            lastTs: Date.now(),
            ok: false
          };
        });
        return false;
      }

      pushHistory({
        id: newId(),
        ts: Date.now(),
        lastTs: Date.now(),
        kind: "single",
        roleRemark: activeRole.remark,
        roleName: activeRole.name || "未知",
        slot,
        mode,
        to,
        text,
        ok: false,
        lastErr: err,
        media: mediaMeta.length ? mediaMeta : undefined
      });

      return false;
    }
  }

  async function sendAllEnabledGroupsConcurrent() {
    if (!activeRole) {
      message.error("请先选择一个角色");
      return;
    }
    if (!activeRole.boundSlot) {
      message.error("该角色未绑定账号，请先绑定账号");
      return;
    }
    if (!enabledGroups.length) {
      message.error("没有启用的群");
      return;
    }

    const hasContent = (text && text.trim().length > 0) || files.length > 0;
    if (!hasContent) {
      message.error("内容或附件至少要有一个");
      return;
    }

    setSending(true);
    setRunIdx(0);

    const bid = newId();
    setBatchId(bid);
    startBatchHistory(bid, enabledGroups.length);

    try {
      const results = await runPool(
        enabledGroups,
        async (g) => {
          await sleep(120);

          const ok = await sendOne(g.id, { batchId: bid });

          setRunIdx((n) => n + 1);
          return ok;
        },
        SEND_CONCURRENCY
      );

      const allOk = results.every(Boolean);

      finalizeBatchHistory(bid);

      setBatchId(null);
      setRunIdx(0);

      if (allOk) {
        setText("");
        setFiles([]);
      }

      message[allOk ? "success" : "warning"](allOk ? "所有群发送成功" : "已发送完，但有失败（看历史 NO）");
    } finally {
      setSending(false);
    }
  }

  // ✅ 新绑定弹窗打开
  function openBind(role: Role) {
    setBindModal({ open: true, role });
    setBindSlot(role.boundSlot || "");
  }
  function closeBind() {
    setBindModal({ open: false, role: null });
    setBindSlot("");
  }
  function saveBind() {
    const role = bindModal.role;
    const v = (bindSlot || "").trim();
    if (!role) return;
    if (!v) return message.error("请选择一个账号坑位");

    // 默认一个账号只绑定一个角色：先解绑其他用同 slot 的
    setRoles(prev =>
      prev
        .map(r => (r.boundSlot === v && r.id !== role.id ? { ...r, boundSlot: undefined } : r))
        .map(r => (r.id === role.id ? { ...r, boundSlot: v } : r))
    );

    void syncNicknameForSlot(v);
    message.success(`已绑定到 ${v}`);
    closeBind();
  }

  const roleMenu = (role: Role): MenuProps => ({
    items: [
      { key: "edit", label: "编辑角色资料" },
      { key: "bind", label: "绑定/替换账号" },
      { key: "unbind", label: "解绑账号" },
      { key: "open_chat", label: "打开聊天" },
      { type: "divider" as const },
      { key: "move_to_top", label: "置顶" },
      { key: "move_to_bottom", label: "置底" },
      { type: "divider" as const },
      { key: "delete", label: "删除角色", danger: true },
    ],
    onClick: async ({ key }) => {
      if (key === "edit") setRoleModal({ open: true, editing: role });
      if (key === "bind") openBind(role);
      if (key === "unbind") {
        setRoles(prev => prev.map(r => (r.id === role.id ? { ...r, boundSlot: undefined } : r)));
      }
      if (key === "open_chat") {
        if (!role.boundSlot) {
          message.error("该角色未绑定账号");
        } else {
          try {
            await http.post(`/api/accounts/${role.boundSlot}/open`);
            message.success("已置顶打开");
          } catch (e) {
            message.error(String(e));
          }
        }
      }

      if (key === "move_to_top") {
        const newRoles = [...roles];
        const index = newRoles.findIndex(r => r.id === role.id);
        if (index > 0) {
          const [roleToMove] = newRoles.splice(index, 1);
          newRoles.unshift(roleToMove);
          setRoles(newRoles);
          saveRoles(newRoles);
        }
      }

      if (key === "move_to_bottom") {
        const newRoles = [...roles];
        const index = newRoles.findIndex(r => r.id === role.id);
        if (index >= 0 && index < newRoles.length - 1) {
          const [roleToMove] = newRoles.splice(index, 1);
          newRoles.push(roleToMove);
          setRoles(newRoles);
          saveRoles(newRoles);
        }
      }

      if (key === "delete") setRoles(prev => prev.filter(r => r.id !== role.id));
    }
  });

  const roleListMenu: MenuProps = {
    items: [
      { key: "add", icon: <PlusOutlined />, label: "+ 新增角色" },
      { key: "refresh", icon: <ReloadOutlined />, label: "刷新列表/昵称" },
      { type: "divider" as const },
      { key: "sort_by_name", label: "按名称排序" },
      { key: "sort_by_status", label: "按状态排序" },
    ],
    onClick: async ({ key }) => {
      if (key === "add") setRoleModal({ open: true, editing: null });
      if (key === "refresh") {
        const reloaded = loadRoles();
        setRoles(reloaded);
        setGroups(loadGroups());
        await refreshAccounts();
        await refreshRoleNicknames();
        message.success("已刷新");
      }

      if (key === "sort_by_name") {
        const newRoles = [...roles].sort((a, b) => a.remark.toLowerCase().localeCompare(b.remark.toLowerCase()));
        setRoles(newRoles);
        saveRoles(newRoles);
        message.success("已按名称排序");
      }

      if (key === "sort_by_status") {
        const score = (slot?: string) => {
          const c = getAccText(slot).color;
          if (c === "green") return 0;
          if (c === "orange") return 1;
          if (c === "red") return 2;
          if (c === "volcano") return 3;
          return 4;
        };
        const newRoles = [...roles].sort((a, b) => score(a.boundSlot) - score(b.boundSlot));
        setRoles(newRoles);
        saveRoles(newRoles);
        message.success("已按状态排序");
      }
    }
  };

  const canSend = useMemo(() => {
    const hasContent = (text && text.trim().length > 0) || files.length > 0;
    if (sending) return false;
    if (!activeRole) return false;
    if (!hasContent) return false;
    if (mode === "enabled_groups") return enabledGroups.length > 0;
    return singleTo.trim().length > 0;
  }, [activeRole, text, files, mode, enabledGroups, runIdx, singleTo, sending]);
  const showHint = !text.trim() && files.length === 0;

  function formatCountdown(ms: number) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    if (h > 0) return `${pad(h)}:${pad(m)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  async function createScheduledJob() {
    if (!activeRole) return message.error("请先选择一个角色");
    if (!activeRole.boundSlot) return message.error("该角色未绑定账号，请先绑定账号");

    const hasContent = (text && text.trim().length > 0) || files.length > 0;
    if (!hasContent) return message.error("内容或附件至少要有一个");
    if (mode === "enabled_groups" && !enabledGroups.length) return message.error("没有启用的群");
    if (mode !== "enabled_groups" && !singleTo.trim()) return message.error("请输入目标");

    const minutes = Math.max(1, Math.min(1440, scheduleMinutes || 1));
    const targets =
      mode === "enabled_groups"
        ? enabledGroups.map(g => g.id)
        : [singleTo.trim()];

    const fd = new FormData();
    fd.append("slot", activeRole.boundSlot);
    fd.append("mode", mode);
    fd.append("minutes", String(minutes));
    fd.append("targets", JSON.stringify(targets));
    fd.append("text", text);
    files.forEach((f) => fd.append("files", f, f.name));

  try {
    // 1) 创建（后端应返回创建后的 job）
    const resp = await http.post("/api/schedules", fd);
    const created = (resp.data?.data || resp.data?.job || job) as ScheduledJob;

    // 2) 立刻插入本地列表（避免必须刷新才看到）
    if (created) {
      setScheduledJobs(prev => {
        const rest = prev.filter(x => x.id !== created.id);
        return [created, ...rest];
      });
    }

    // 3) 关闭弹窗 & 清空输入
    setScheduleOpen(false);
    setText("");
    setFiles([]);

    // 4) 可选：再拉一次全量，保证与后端一致（如果你后端会补字段/排序）
    // const r = await http.get("/api/schedules");
    // setScheduledJobs((r.data?.data || []) as ScheduledJob[]);

    message.success(`已安排：${minutes}分钟后发送`);
  } catch (e: any) {
    message.error(`定时任务创建失败：${e?.response?.data?.error || e.message}`);
  }


  async function doSendNow() {
    if (!activeRole) return message.error("请先选择一个角色");
    const hasContent = (text && text.trim().length > 0) || files.length > 0;
    if (!hasContent) return message.error("内容或附件至少要有一个");

    if (mode === "enabled_groups") {
      await sendAllEnabledGroupsConcurrent();
      return;
    }
    const ok = await sendOne(singleTo.trim());
    if (ok) {
      setText("");
      setFiles([]);
    }
    ok ? message.success("立即发送成功") : message.error("立即发送失败（见记录）");
  }

  const activeScheduledJobs = useMemo(() => {
    return scheduledJobs
      .filter(j => j.status === "pending" || j.status === "running")
      .sort((a, b) => a.runAt - b.runAt)
      .slice(0, 5);
  }, [scheduledJobs]);

  async function cancelScheduledJob(job: ScheduledJob) {
    try {
      await http.post(`/api/schedules/${job.id}/cancel`);
      const r = await http.get("/api/schedules");
      setScheduledJobs((r.data?.data || []) as ScheduledJob[]);
      message.success("已取消定时任务");
    } catch (e: any) {
      message.error(`取消失败：${e?.response?.data?.error || e.message}`);
    }
  }

  // 绑定弹窗 options（来自 accounts）
  const bindOptions = useMemo(() => {
    const list = (accounts || []).slice().sort((a, b) =>
      String(a.slot).localeCompare(String(b.slot), "en", { numeric: true })
    );

    return list.map(a => ({
      value: a.slot,
      label: (
        <Space size={8} wrap>
          <b style={{ width: 44, display: "inline-block" }}>{a.slot}</b>
          <Tag color={statusColor(a.status)}>{a.status}</Tag>
          <span style={{ opacity: 0.9 }}>{a.phone || "-"}</span>
          <span style={{ opacity: 0.9 }}>{a.nickname || "-"}</span>
        </Space>
      ),
      rawLabel: slotLabel(a),
    }));
  }, [accounts]);

  return (
    <>
      <Row gutter={16} style={{ height: PAGE_H, overflow: "hidden" }}>
        <Col span={7} style={{ height: "100%" }}>
          <Card
            style={{ height: "100%" }}
            title="角色列表（坑位）"
            bodyStyle={{ height: "calc(100% - 57px)", overflowY: "auto", padding: 10 }}
            extra={
              <Dropdown menu={roleListMenu} placement="bottomRight" trigger={["click"]}>
                <Button type="primary" icon={<PlusOutlined />}>操作</Button>
              </Dropdown>
            }
          >
            <div style={{ marginBottom: 8, fontSize: 12, color: "#666" }}>
              提示：拖动左侧 <DragOutlined style={{ fontSize: 10 }} /> 图标可以调整角色顺序
            </div>

            {roles.map((r) => {
              const acc = getAccText(r.boundSlot);
              const showName = r.name || "未知";
              const isSelected = r.id === activeRoleId;
              const isDragging = r.id === draggingId;
              const isDraggingOver = r.id === draggingOverId;

              return (
                <div
                  key={r.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, r.id)}
                  onDragOver={(e) => handleDragOver(e, r.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, r.id)}
                  onDragEnd={handleDragEnd}
                  style={{
                    cursor: "pointer",
                    background: isSelected
                      ? "linear-gradient(135deg, #1890ff 0%, #1677ff 100%)"
                      : isDraggingOver
                        ? "linear-gradient(135deg, #f0f7ff 0%, #e6f7ff 100%)"
                        : "transparent",
                    borderRadius: 12,
                    padding: isSelected ? "14px 12px" : "8px 10px",
                    marginBottom: 8,
                    border: isSelected
                      ? "2px solid #1890ff"
                      : isDraggingOver
                        ? "2px dashed #1890ff"
                        : "1px solid #f0f0f0",
                    boxShadow: isSelected
                      ? "0 4px 12px rgba(24, 144, 255, 0.4), 0 2px 6px rgba(24, 144, 255, 0.3)"
                      : isDraggingOver
                        ? "0 2px 8px rgba(24, 144, 255, 0.2)"
                        : "0 1px 3px rgba(0, 0, 0, 0.05)",
                    transform: isDragging ? "scale(0.98)" : (isSelected ? "scale(1.02)" : "scale(1)"),
                    transition: "all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)",
                    position: "relative",
                    overflow: "hidden",
                    zIndex: isSelected ? 1 : 0,
                    opacity: isDragging ? 0.6 : 1,
                  }}
                  onClick={() => setActiveRoleId(r.id)}
                >
                  {isSelected && (
                    <div style={{
                      position: "absolute",
                      top: -10,
                      right: -10,
                      width: 20,
                      height: 20,
                      background: "#1890ff",
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}>
                      <div style={{
                        width: 8,
                        height: 8,
                        background: "white",
                        borderRadius: "50%",
                      }} />
                    </div>
                  )}

                  <div
                    style={{
                      position: "absolute",
                      left: 4,
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: isSelected ? "rgba(255, 255, 255, 0.7)" : "#999",
                      cursor: "grab",
                      padding: "4px 2px",
                      zIndex: 10,
                      userSelect: "none",
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <DragOutlined style={{ fontSize: 12 }} />
                  </div>

                  <div style={{
                    width: "100%",
                    minWidth: 0,
                    position: "relative",
                    zIndex: 2,
                    marginLeft: 16
                  }}>
                    <div style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: isSelected ? 900 : 800,
                            fontSize: isSelected ? 14 : 13,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            color: isSelected ? "white" : "inherit",
                            textShadow: isSelected ? "0 1px 2px rgba(0, 0, 0, 0.2)" : "none",
                          }}
                          title={`${r.remark} - ${showName}`}
                        >
                          {r.remark} - {showName}
                          <Tag
                            color={isSelected ? "white" : acc.color as any}
                            style={{
                              marginLeft: 8,
                              height: 18,
                              lineHeight: "16px",
                              background: isSelected ? "rgba(255, 255, 255, 0.9)" : undefined,
                              color: isSelected ? "#1890ff" : undefined,
                              borderColor: isSelected ? "white" : undefined,
                              fontWeight: isSelected ? 600 : "normal",
                            }}
                          >
                            {acc.text}
                          </Tag>
                        </div>
                      </div>

                      <div style={{ flex: "0 0 auto", marginLeft: 8 }}>
                        <Dropdown key="more" menu={roleMenu(r)} placement="bottomRight">
                          <Button
                            size="small"
                            icon={<MoreOutlined />}
                            style={{
                              background: isSelected ? "rgba(255, 255, 255, 0.9)" : "transparent",
                              color: isSelected ? "#1890ff" : undefined
                            }}
                          />
                        </Dropdown>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </Card>
        </Col>

        <Col span={17} style={{ height: "100%" }}>
          <Card
            style={{ height: "100%" }}
            title={
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <span style={{ fontWeight: 800 }}>任务编辑</span>
                <Space size={8} style={{ flexWrap: "nowrap" }}>
                  <Button size="small" onClick={refreshAccounts}>刷新账号状态</Button>
                  <Button size="small" onClick={() => void refreshRoleNicknames()}>刷新昵称</Button>
                </Space>
              </div>
            }
            bodyStyle={{
              height: "calc(100% - 57px)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>

              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 90, color: "#666", fontSize: 12, flex: "0 0 auto" }}>任务类型：</div>

                <Select
                  style={{ width: 520, maxWidth: "100%" }}
                  value={mode}
                  onChange={(v) => { setMode(v); setRunIdx(0); }}
                  options={[
                    { value: "enabled_groups", label: "对启用群发送（来自群页开关）" },
                    { value: "single_group", label: "单个群（从群列表选择/可手填）" },
                    { value: "single_contact", label: "单个联系人（手填 @c.us）" },
                  ]}
                />
              </div>

              {mode === "single_group" && (
                <AutoComplete
                  style={{ width: "100%" }}
                  options={groupOptions}
                  value={singleTo}
                  onChange={(v) => setSingleTo(v)}
                  placeholder="选择群（来自群页）或手动输入 12345@g.us"
                  filterOption={(input, option) =>
                    String(option?.value || "").toLowerCase().includes(input.toLowerCase()) ||
                    String(option?.label || "").toLowerCase().includes(input.toLowerCase())
                  }
                />
              )}

              {mode === "single_contact" && (
                <Input
                  style={{ width: "100%" }}
                  value={singleTo}
                  onChange={(e) => setSingleTo(e.target.value)}
                  placeholder="例：94771234567@c.us"
                />
              )}

              {mode === "enabled_groups" && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Tag color="blue">启用群：{enabledGroups.length} 个</Tag>
                  <Tag>进度：{Math.min(runIdx, enabledGroups.length)}/{enabledGroups.length}</Tag>
                  {nextGroup && <Tag color="geekblue">下一群：{nextGroup.name}</Tag>}
                  <Button size="small" onClick={() => setGroups(loadGroups())}>刷新群列表</Button>
                </div>
              )}

              <Card
                size="small"
                title="发送记录（本机存档）"
                extra={
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => { setHistory([]); saveHis([]); }}
                  >
                    清空
                  </Button>
                }
                style={{ flex: "1 1 auto", overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 200 }}
                bodyStyle={{ flex: 1, overflowY: "auto" }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {history.map((h) => {
                    const st =
                      h.running ? { text: "发送中", color: "blue" } :
                        h.ok ? { text: "OK", color: "green" } :
                          { text: "NO", color: "red" };

                    const timeText = fmtTime(h.lastTs || h.ts);

                    return (
                      <div key={h.id} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                        <div style={{ width: 42, textAlign: "center", paddingTop: 2 }}>
                          <Tag color={st.color as any} style={{ marginRight: 0, minWidth: 40, textAlign: "center" }}>
                            {st.text}
                          </Tag>
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                            <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              备注：{h.roleRemark}
                              {h.kind === "batch" && (
                                <span style={{ marginLeft: 8, fontWeight: 500, color: "#666" }}>
                                  {h.okCount || 0}/{h.total || 0}{h.failCount ? `（失败${h.failCount}）` : ""}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 12, color: "#999", flex: "0 0 auto" }}>{timeText}</div>
                          </div>

                          <div
                            style={{
                              marginTop: 6,
                              background: "#fafafa",
                              border: "1px solid #f0f0f0",
                              borderRadius: 12,
                              padding: "10px 12px",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word"
                            }}
                          >
                            {h.text ? h.text : (h.media?.length ? `（仅媒体 ${h.media.length} 个）` : "")}
                          </div>

                          {!!h.media?.length && (
                            <div style={{ marginTop: 6, fontSize: 12, color: "#888" }}>
                              媒体：{h.media.length} 个
                            </div>
                          )}

                          {!h.ok && !h.running && h.lastErr && (
                            <div style={{ marginTop: 6, fontSize: 12, color: "#999" }}>
                              失败原因：{h.lastErr}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div ref={hisBottomRef} />

                </div>
              </Card>

              <Row gutter={16} style={{ marginTop: "auto" }} align="stretch">
                <Col span={16}>
                  <div style={{
                    border: "1px solid #d9d9d9",
                    borderRadius: 8,
                    padding: 16,
                    background: "#fafafa",
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                  }}>
                    <input
                      ref={filePickRef}
                      type="file"
                      multiple
                      accept="image/*,video/*"
                      style={{ display: "none" }}
                      onChange={onPickFiles}
                    />

                    <div
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={onDropFiles}
                      style={{
                        border: "1px dashed #d9d9d9",
                        borderRadius: 8,
                        padding: 14,
                        background: "#fff",
                        height: inputAreaH,
                        display: "flex",
                        flexDirection: "column",
                        overflow: "hidden",
                        position: "relative",
                        minHeight: 0,
                      }}
                    >
                      {showHint && (
                        <div
                          style={{
                            position: "absolute",
                            left: 14,
                            top: 12,
                            fontSize: 12,
                            color: "#999",
                            pointerEvents: "none",
                            zIndex: 2,
                          }}
                        >
                          提示：拖拽图片/视频到这个框内即可添加附件（也支持 Ctrl+V）
                        </div>
                      )}
                      {files.length > 0 && (
                        <Tag
                          color="purple"
                          style={{
                            position: "absolute",
                            right: 14,
                            top: 10,
                            zIndex: 2,
                            margin: 0,
                            borderRadius: 8,
                            padding: "4px 10px",
                          }}
                        >
                          已选媒体 {files.length} 个
                        </Tag>
                      )}

                      <Input.TextArea
                        ref={textAreaRef}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onPaste={onPasteFiles}
                        onKeyDown={(e) => {
                          const isComposing = e.nativeEvent.isComposing || e.isComposing;
                          if (e.key === "Enter" && !e.shiftKey && !isComposing) {
                            e.preventDefault();
                            void doSendNow();
                          }
                        }}
                        placeholder="Enter 发送，Shift+Enter 换行…"
                        autoSize={false}
                        style={{
                          flex: 1,
                          minHeight: 0,
                          fontSize: 14,
                          resize: "none",
                          border: "none",
                          padding: 12,
                          lineHeight: 1.5,
                          overflowY: "auto",
                          marginTop: showHint ? 18 : 0
                        }}
                      />

                      {files.length > 0 && (
                        <div
                          style={{
                            marginTop: 10,
                            paddingTop: 10,
                            borderTop: "1px dashed #eee",
                            display: "flex",
                            gap: 8,
                            overflowX: "auto",
                            overflowY: "hidden",
                            whiteSpace: "nowrap",
                            flex: "0 0 auto",
                            scrollbarWidth: "thin",
                          }}
                        >
                          {previews.map((p, idx) => (
                            <div
                              key={p.key}
                              style={{
                                flex: "0 0 auto",
                                width: 96,
                                border: "1px solid #eee",
                                borderRadius: 10,
                                padding: 8,
                                background: "#fff",
                                position: "relative",
                                boxShadow: "0 1px 4px rgba(0, 0, 0, 0.06)",
                              }}
                            >
                              <Button
                                size="small"
                                danger
                                icon={<CloseOutlined />}
                                onClick={() => setFiles(prev => prev.filter((_, i) => i !== idx))}
                                style={{
                                  position: "absolute",
                                  top: 4,
                                  right: 4,
                                  minWidth: 22,
                                  height: 22,
                                  paddingInline: 0,
                                  borderRadius: "50%",
                                }}
                              />
                              {p.isImg ? (
                                <img src={p.url} style={{ width: "100%", height: 64, objectFit: "cover", borderRadius: 8 }} />
                              ) : (
                                <div style={{ height: 64, display: "flex", alignItems: "center", justifyContent: "center", background: "#fafafa", borderRadius: 8 }}>
                                  <span style={{ color: "#666" }}>VIDEO</span>
                                </div>
                              )}
                              <div style={{ marginTop: 6, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={p.file.name}>
                                {p.file.name}
                              </div>
                              <div style={{ fontSize: 12, color: "#888" }}>{humanSize(p.file.size)}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </Col>

                <Col span={8} style={{ display: "flex", flexDirection: "column" }}>

                  <Card
                    size="small"
                    style={{
                      width: "100%",
                      height: inputAreaH,
                      display: "flex",
                      flexDirection: "column",
                      marginTop: "auto",
                      overflow: "hidden"
                    }}
                    bodyStyle={{
                      padding: 16,
                      flex: 1,
                      overflow: "hidden",
                      minHeight: 0,
                      display: "flex",
                      flexDirection: "column"
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0, flex: 1 }}>
                      <Typography.Text style={{ fontWeight: 600 }}>
                        当前角色：{activeRole?.remark || "-"}
                      </Typography.Text>

                      <Button
                        type="primary"
                        block
                        size="middle"
                        disabled={!canSend}
                        onClick={() => void doSendNow()}
                        style={{ height: 40, fontSize: 14 }}
                      >
                        立即发送
                      </Button>

                      <Row gutter={8}>
                        <Col span={12}>
                          <Button
                            block
                            size="small"
                            onClick={() => filePickRef.current?.click()}
                            style={{ height: 32 }}
                          >
                            选择媒体
                          </Button>
                        </Col>
                        <Col span={12}>
                          <Button
                            block
                            size="small"
                            disabled={!canSend}
                            onClick={() => setScheduleOpen(true)}
                            style={{ height: 32 }}
                          >
                            定时发送
                          </Button>
                        </Col>
                      </Row>

                      <Card
                        size="small"
                        title="定时任务"
                        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
                        bodyStyle={{ padding: 10, flex: 1, overflowY: "auto", minHeight: 0 }}
                      >
                        {activeScheduledJobs.length === 0 ? (
                          <div style={{ fontSize: 12, color: "#999" }}>暂无待执行任务</div>
                        ) : (
                          <Space direction="vertical" style={{ width: "100%" }} size={8}>
                            {activeScheduledJobs.map((job) => {
                              const remainMs = job.runAt - nowTs;
                              const remainText = formatCountdown(remainMs);
                              const targetText = job.mode === "enabled_groups" ? "启用群" : (job.targets?.[0] || "-");
                              const hintText =
                                job.status === "running"
                                  ? `执行中 / 目标：${targetText}`
                                  : `${Math.max(1, Math.ceil(remainMs / 60000))}分钟后发送 / 目标：${targetText}`;
                              return (
                                <div key={job.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                  <Tag color={job.status === "running" ? "blue" : "green"} style={{ marginRight: 0 }}>
                                    OK
                                  </Tag>
                                  <div style={{ width: 50, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                                    {remainText}
                                  </div>
                                  <div style={{ flex: 1, fontSize: 12, color: "#555" }}>{hintText}</div>
                                  <Button size="small" danger onClick={() => cancelScheduledJob(job)}>
                                    取消
                                  </Button>
                                </div>
                              );
                            })}
                          </Space>
                        )}
                      </Card>

                      {mode === "enabled_groups" && enabledGroups.length > 0 && (
                        <div style={{ marginTop: 4, textAlign: "center" }}>
                          <Typography.Text type="secondary">
                            进度: {Math.min(runIdx, enabledGroups.length)}/{enabledGroups.length}
                          </Typography.Text>
                          <div style={{ marginTop: 4 }}>
                            <div style={{
                              width: "100%",
                              height: 6,
                              backgroundColor: "#f0f0f0",
                              borderRadius: 3,
                              overflow: "hidden"
                            }}>
                              <div
                                style={{
                                  width: `${(runIdx / enabledGroups.length) * 100}%`,
                                  height: "100%",
                                  backgroundColor: "#1890ff",
                                  transition: "width 0.3s"
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </Card>
                </Col>
              </Row>

            </div>
          </Card>
        </Col>
      </Row>

      <Modal
        title="定时发送"
        open={scheduleOpen}
        onCancel={() => setScheduleOpen(false)}
        onOk={() => void createScheduledJob()}
        okText="确认"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <div>
            <Typography.Text>X 分钟后</Typography.Text>
            <InputNumber
              min={1}
              max={1440}
              step={1}
              value={scheduleMinutes}
              onChange={(v) => setScheduleMinutes(Number(v || 1))}
              style={{ width: "100%", marginTop: 6 }}
            />
          </div>
          <Typography.Text type="secondary">
            将使用当前角色/当前模式/当前内容/当前附件执行一次发送
          </Typography.Text>
        </Space>
      </Modal>

      {/* ✅ 绑定/替换账号弹窗（任意角色都可随意换到任何 Axx） */}
      <Modal
        title={`绑定/替换账号：${bindModal.role?.remark || ""} - ${bindModal.role?.name || "未知"}`}
        open={bindModal.open}
        onCancel={closeBind}
        onOk={saveBind}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Typography.Text style={{ opacity: 0.75 }}>
            这里随时可以把角色从 A3 换到 A35/A36…；需要换回时再选回 A3 即可。
          </Typography.Text>

          <div>
            <Typography.Text>选择账号 slot（A1/A2/A35...）</Typography.Text>
            <Select
              style={{ width: "100%", marginTop: 6 }}
              value={bindSlot || undefined}
              placeholder="请选择..."
              options={bindOptions as any}
              onChange={(v) => setBindSlot(String(v))}
              showSearch
              optionFilterProp="rawLabel"
              filterOption={(input, option: any) =>
                String(option?.rawLabel || "").toLowerCase().includes(String(input || "").toLowerCase())
              }
            />
          </div>

          <div style={{ opacity: 0.75 }}>
            小提示：如果 slot 不是 READY，也能绑定，但发送可能失败；你可以先去账号页「打开 → 登录/扫码」。
          </div>
        </Space>
      </Modal>

      <RoleModal
        open={roleModal.open}
        editing={(roleModal.editing as any) || null}
        onCancel={() => setRoleModal({ open: false })}
        onOk={(payload) => {
          const editing = roleModal.editing as Role | null | undefined;
          if (editing) {
            setRoles(prev => prev.map(r => r.id === editing.id ? { ...r, ...payload } : r));
          } else {
            setRoles(prev => [{ id: uid(), remark: payload.remark, name: payload.name, boundSlot: undefined }, ...prev]);
          }
          setRoleModal({ open: false });
        }}
      />
    </>
  );
}

type RoleModalProps = {
  open: boolean;
  editing: Role | null;
  onCancel: () => void;
  onOk: (payload: { remark: string; name: string }) => void;
};

function RoleModal(props: RoleModalProps): JSX.Element {
  const [remark, setRemark] = useState(props.editing?.remark || "");
  const [name, setName] = useState(props.editing?.name || "未知");

  useEffect(() => {
    setRemark(props.editing?.remark || "");
    setName(props.editing?.name || "未知");
  }, [props.editing, props.open]);

  return (
    <Modal
      title={props.editing ? "编辑角色" : "新增角色"}
      open={props.open}
      onCancel={props.onCancel}
      onOk={() => {
        if (!remark.trim()) return message.error("备注不能为空（如：老师/助理）");
        props.onOk({ remark: remark.trim(), name: name.trim() || "未知" });
      }}
      okText="保存"
      cancelText="取消"
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <div>
          <Typography.Text>备注（如：老师/助理/老手1）</Typography.Text>
          <Input value={remark} onChange={(e) => setRemark(e.target.value)} />
        </div>
        <div>
          <Typography.Text>显示名（默认：未知；绑定账号后可自动更新）</Typography.Text>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </Space>
    </Modal>
  );
}

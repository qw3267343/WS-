import type { GroupTarget, Role } from "./types";

const K_ROLES  = "wa_roles_v1";
const K_GROUPS = "wa_groups_v1";
const K_SLOTS  = "wa_slots_v1";

export function loadSlots(): string[] {
  const raw = localStorage.getItem(K_SLOTS) || "acc001,acc002,acc003";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}
export function saveSlots(raw: string) {
  localStorage.setItem(K_SLOTS, raw);
}

export function loadRoles(): Role[] {
  let arr: Role[] = [];
  try { arr = JSON.parse(localStorage.getItem(K_ROLES) || "[]"); } catch { arr = []; }

  // 自动补齐默认 33 个角色（不覆盖已有）
  const next = ensureDefaultRoles(arr);
  if (next !== arr) saveRoles(next);
  return next;
}
export function saveRoles(rows: Role[]) {
  localStorage.setItem(K_ROLES, JSON.stringify(rows));
}

export function loadGroups(): GroupTarget[] {
  try { return JSON.parse(localStorage.getItem(K_GROUPS) || "[]"); } catch { return []; }
}
export function saveGroups(rows: GroupTarget[]) {
  localStorage.setItem(K_GROUPS, JSON.stringify(rows));
}

export function uid(prefix="id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

const DEFAULT_ROLE_REMARKS: string[] = [
  "admin",
  "老师",
  "助理",
  ...Array.from({ length: 15 }, (_, i) => `老手${i + 1}`),
  ...Array.from({ length: 15 }, (_, i) => `新手${i + 1}`),
];

function ensureDefaultRoles(existing: Role[]): Role[] {
  const seen = new Set(existing.map(r => r.remark));
  let changed = false;
  const out = [...existing];

  for (const remark of DEFAULT_ROLE_REMARKS) {
    if (!seen.has(remark)) {
      out.push({ id: uid("role"), remark, name: "未知" });
      changed = true;
    }
  }
  return changed ? out : existing;
}

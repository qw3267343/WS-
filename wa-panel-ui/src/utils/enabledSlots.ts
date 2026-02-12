const KEY = "wa.enabledSlots.v1";

export function loadEnabledMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveEnabledMap(map: Record<string, boolean>) {
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function isSlotEnabled(slot: string) {
  const map = loadEnabledMap();
  return map[slot] !== false;
}

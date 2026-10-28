export function runContextPanelActionWithClose({
  action,
  close,
}: {
  action?: () => void;
  close: () => void;
}) {
  // HoverCard 内按钮点击不会像外部 hover leave 一样自动关闭面板。
  // 入口动作会切到设置页或 usage 详情，必须先收起 context 面板，避免旧浮层残留。
  close();
  action?.();
}

/**
 * Radix HoverCard 会在 touchstart 中阻止后续 click，手机端无法靠 click 打开面板；
 * 触摸 pointerdown 阶段需要自行打开，桌面端继续保持原有 hover/focus 语义。
 */
export function isHoverlessTouchPointerDown(event: {
  defaultPrevented: boolean;
  pointerType?: string;
}): boolean {
  return (
    !event.defaultPrevented &&
    event.pointerType === "touch" &&
    typeof window !== "undefined" &&
    window.matchMedia?.("(hover: none)").matches === true
  );
}

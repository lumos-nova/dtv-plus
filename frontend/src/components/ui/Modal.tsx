import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { usePortalHost } from "@/lib/portal";
import styles from "./Modal.module.css";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 底部操作区（可选） */
  footer?: ReactNode;
  /** 面板宽度，默认 460px */
  width?: number;
  className?: string;
  /** 是否允许点击遮罩关闭，默认 true */
  dismissOnBackdrop?: boolean;
  labelId?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * 共享弹窗外壳（R-01 / U-22）。
 *
 * 统一处理：遮罩点击、Esc 关闭、焦点陷阱、关闭后焦点归还、aria-modal、
 * 出入场动画。业务弹窗只负责内容，不再各写一套 backdrop / 定位 / 关闭逻辑。
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 460,
  className,
  dismissOnBackdrop = true,
  labelId,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // todo05：DOM 全屏（监看单卡 / 播放器舞台）下 body 上的弹层不可见，
  // 挂到全屏元素内部，退出全屏自动回到 body。
  const portalHost = usePortalHost();
  // todo02：标题栏拖动弹窗（设置 / 存储设置等所有共用 Modal 的弹窗均生效）
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    rect: DOMRect;
  } | null>(null);

  const onHeaderPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if ((event.target as Element).closest("button")) return;
      const panel = panelRef.current;
      if (!panel) return;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        baseX: dragOffset.x,
        baseY: dragOffset.y,
        rect: panel.getBoundingClientRect(),
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    },
    [dragOffset],
  );

  const onHeaderPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // 限制平移范围：弹窗整体保持在视口内（至少留 8px 可见）
    const minDx = 8 - drag.rect.left;
    const maxDx = window.innerWidth - 8 - drag.rect.right;
    const minDy = 8 - drag.rect.top;
    const maxDy = window.innerHeight - 8 - drag.rect.bottom;
    const dx = Math.min(maxDx, Math.max(minDx, event.clientX - drag.startX));
    const dy = Math.min(maxDy, Math.max(minDy, event.clientY - drag.startY));
    setDragOffset({ x: drag.baseX + dx, y: drag.baseY + dy });
  }, []);

  const onHeaderPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );
      if (nodes.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // 打开后把焦点移进弹窗：优先第一个可聚焦控件，否则面板本身。
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (dismissOnBackdrop && event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        className={cn(styles.panel, className)}
        style={{
          width: `min(${width}px, calc(100vw - 40px))`,
          transform:
            dragOffset.x !== 0 || dragOffset.y !== 0
              ? `translate(${dragOffset.x}px, ${dragOffset.y}px)`
              : undefined,
        }}
        role="dialog"
        aria-modal="true"
        aria-label={labelId ? undefined : title}
        aria-labelledby={labelId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header
          className={cn(styles.header, dragging && styles.headerDragging)}
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerUp}
        >
          <h2 className={styles.title} id={labelId}>
            {title}
          </h2>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            <X size={15} strokeWidth={2.4} />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </div>,
    portalHost,
  );
}

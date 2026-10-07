import { useEffect, useRef, useState, type ReactNode } from "react";

/** A persistent desktop sidebar becomes a native modal drawer on narrow screens. */
export function RoomPanel({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const [drawer, setDrawer] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)");
    const update = () => setDrawer(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!drawer) return;
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [drawer]);

  return drawer ? <dialog ref={ref} className="room-rules room-drawer" aria-label="房间面板" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }}>{children}</dialog> : <aside className="room-rules" aria-label="房间面板">{children}</aside>;
}

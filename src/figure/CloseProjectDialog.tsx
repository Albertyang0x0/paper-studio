import { useEffect, useId, useRef } from "react";
import { Download, X } from "lucide-react";

export function CloseProjectDialog({ title, error, onCancel, onClose }: {
  title: string;
  error: string;
  onCancel: () => void;
  onClose: (exportFirst: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointerDown = useRef(false);
  const headingId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const node = dialog.current!;
    const previousFocus = document.activeElement;
    node.showModal();
    return () => {
      node.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected && !previousFocus.matches(":disabled")) {
        previousFocus.focus();
      } else {
        document.querySelector<HTMLButtonElement>('button[aria-label="打开项目"]')?.focus();
      }
    };
  }, []);
  const outsideDialog = (clientX: number, clientY: number) => {
    const bounds = dialog.current!.getBoundingClientRect();
    return clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom;
  };
  return <dialog
    ref={dialog}
    className="close-project-dialog"
    aria-labelledby={headingId}
    aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onCancel(); }}
    onPointerDown={event => {
      backdropPointerDown.current = event.target === event.currentTarget && outsideDialog(event.clientX, event.clientY);
    }}
    onClick={event => {
      if (backdropPointerDown.current && event.target === event.currentTarget && outsideDialog(event.clientX, event.clientY)) onCancel();
      backdropPointerDown.current = false;
    }}
  >
    <header className="generation-header">
      <h2 id={headingId}>关闭当前项目</h2>
      <button type="button" aria-label="取消关闭项目" onClick={onCancel}><X size={17} /></button>
    </header>
    <div className="close-project-body">
      <strong title={title}>{title}</strong>
      <p id={descriptionId}>关闭会清空当前画板和浏览器中的恢复记录。服务器历史项目会保留；如需保留当前修改，请先导出 JSON。</p>
      {error && <p className="generation-error" role="alert">{error}</p>}
    </div>
    <footer className="close-project-actions">
      <button type="button" className="button" autoFocus onClick={onCancel}>取消</button>
      <button type="button" className="button" onClick={() => onClose(false)}>直接关闭</button>
      <button type="button" className="button dark" onClick={() => onClose(true)}><Download size={15} />导出 JSON 并关闭</button>
    </footer>
  </dialog>;
}

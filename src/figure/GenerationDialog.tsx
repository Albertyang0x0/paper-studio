import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

type Props = {
  tab: "figure" | "models";
  onTabChange: (tab: "figure" | "models") => void;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
};

export function GenerationDialog({ tab, onTabChange, onClose, children, actions }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    node.showModal();
    return () => { node.close(); previousFocus?.focus(); };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="generation-dialog"
      aria-labelledby="generation-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right ||
            event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      <header className="generation-header">
        <h2 id="generation-title">生成图表</h2>
        <button aria-label="关闭生成设置" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="generation-tabs" role="tablist" aria-label="生成设置">
        <button role="tab" aria-selected={tab === "figure"} aria-controls="generation-figure" id="generation-figure-tab" onClick={() => onTabChange("figure")}>图形与参考</button>
        <button role="tab" aria-selected={tab === "models"} aria-controls="generation-models" id="generation-models-tab" onClick={() => onTabChange("models")}>方法与模型</button>
      </div>
      <div className="generation-body" role="tabpanel" id={`generation-${tab}`} aria-labelledby={`generation-${tab}-tab`}>
        {children}
      </div>
      <footer className="generation-footer">{actions}</footer>
    </dialog>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Layers, Lock, X } from "lucide-react";
import type { FigureScene, GroupMember } from "../../shared/types";
import { isMemberLocked, memberKey, memberLabel } from "../../shared/manual-groups";

export function ManualGroupingPanel({ scene, members, preview, busy, onPreview, onRemove, onRestart, onCancel, onConfirm }: {
  scene: FigureScene;
  members: GroupMember[];
  preview?: GroupMember;
  busy: boolean;
  onPreview: (member: GroupMember) => void;
  onRemove: (member: GroupMember) => void;
  onRestart: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <section className="manual-group-draft" data-testid="manual-group-draft" aria-label="确认框选图层">
    <strong aria-live="polite">已选 {members.length} 个对象</strong>
    <p className="hint">点击名称查看对象，移出选区不会删除图中内容。</p>
    <ul>
      {members.map(member => <li key={memberKey(member)} data-group-member={memberKey(member)}>
        <button type="button" data-testid="preview-group-member"
          className={preview && memberKey(preview) === memberKey(member) ? "selected" : ""}
          aria-pressed={Boolean(preview && memberKey(preview) === memberKey(member))}
          disabled={busy} onClick={() => onPreview(member)} title={memberLabel(scene, member)}>
          <span>{memberLabel(scene, member)}</span>
          {isMemberLocked(scene, member) && <Lock size={12} />}
        </button>
        <button type="button" disabled={busy} aria-label={`移出选区 ${memberLabel(scene, member)}`}
          onClick={() => onRemove(member)}><X size={13} /></button>
      </li>)}
    </ul>
    {members.length < 2 && <p className="hint">至少选择两个对象才能组合。</p>}
    <button type="button" className="button dark" disabled={busy || members.length < 2} onClick={onConfirm}>组合所选图层</button>
    <div className="manual-group-actions">
      <button type="button" disabled={busy} onClick={onRestart}>重新框选</button>
      <button type="button" disabled={busy} onClick={onCancel}>取消框选</button>
    </div>
  </section>;
}

export function ManualGroupLayers({ scene, moduleId, selectedGroupId, selectedMember, busy, onSelect, renderMember }: {
  scene: FigureScene;
  moduleId?: string;
  selectedGroupId?: string;
  selectedMember?: GroupMember;
  busy: boolean;
  onSelect: (groupId: string) => void;
  renderMember: (member: GroupMember) => ReactNode;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const groups = scene.manualGroups ?? [];
  const nestedIds = new Set(groups.flatMap(group => group.members.filter(member => member.kind === "group").map(member => member.id)));
  const selectedKey = selectedMember ? memberKey(selectedMember) : selectedGroupId ? memberKey({ kind: "group", id: selectedGroupId, moduleId }) : "";
  const findAncestors = (id: string, trail: string[] = []): string[] | undefined => {
    if (trail.includes(id)) return undefined;
    const group = groups.find(candidate => candidate.id === id);
    if (!group) return undefined;
    for (const member of group.members) {
      if (memberKey(member) === selectedKey) return [...trail, id];
      if (member.kind === "group") {
        const found = findAncestors(member.id, [...trail, id]);
        if (found) return found;
      }
    }
  };
  const roots = groups.filter(group => group.moduleId === moduleId && !nestedIds.has(group.id));
  const ancestorsKey = JSON.stringify(roots.flatMap(group => findAncestors(group.id) ?? []));
  useEffect(() => {
    const ancestors = JSON.parse(ancestorsKey) as string[];
    if (ancestors.length) setExpanded(previous => new Set([...previous, ...ancestors]));
  }, [selectedKey, ancestorsKey]);
  const renderGroup = (id: string, trail: string[] = []): ReactNode => {
    const group = groups.find(candidate => candidate.id === id);
    if (!group || trail.includes(id)) return null;
    const open = expanded.has(id);
    return <div className="manual-group-node" key={id}>
      <div className="manual-group-row">
        <button type="button" className="manual-group-toggle" data-manual-group-toggle={id}
          aria-label={`${open ? "收起" : "展开"}组合 ${group.title}`} aria-expanded={open}
          onClick={() => setExpanded(previous => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          })}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
        <button type="button" data-manual-group={id} disabled={busy}
          className={`layer-row${selectedGroupId === id ? " selected" : ""}`}
          onClick={() => onSelect(id)}>
          <Layers size={14} /><strong>{group.title}</strong><small>{group.members.length}</small>
          {isMemberLocked(scene, { kind: "group", id, moduleId: group.moduleId }) && <Lock size={11} />}
        </button>
      </div>
      {open && <div className="manual-group-members">
        {group.members.map(member => <div key={memberKey(member)} data-group-member={memberKey(member)}>
          {member.kind === "group" ? renderGroup(member.id, [...trail, id]) : renderMember(member)}
        </div>)}
      </div>}
    </div>;
  };
  return <>{roots.map(group => renderGroup(group.id))}</>;
}

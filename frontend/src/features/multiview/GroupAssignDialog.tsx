import { Check, FolderPlus, X } from "lucide-react";
import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/cn";
import styles from "./GroupAssignDialog.module.css";

export interface GroupFolderOption {
  id: string;
  name: string;
}

interface GroupAssignDialogProps {
  /** 侧边栏关注列表的文件夹（实时同步） */
  folders: GroupFolderOption[];
  /** 当前主播所在的文件夹 id（不在任何文件夹时为 undefined） */
  currentFolderId?: string;
  roomLabel: string;
  onAssign: (folderId: string) => void;
  onCreateAndAssign: (name: string) => void;
  onRemove: () => void;
  onClose: () => void;
}

/**
 * 「添加分组」弹窗：与侧边栏关注列表的文件夹共用同一份数据。
 * 选择文件夹 → 主播移入该文件夹；输入新名称 → 创建侧边栏文件夹并移入；
 * 未关注的主播会先自动关注。重名时直接加入已有文件夹。
 */
export function GroupAssignDialog({
  folders,
  currentFolderId,
  roomLabel,
  onAssign,
  onCreateAndAssign,
  onRemove,
  onClose,
}: GroupAssignDialogProps) {
  const [newGroup, setNewGroup] = useState("");
  const trimmed = newGroup.trim().slice(0, 40);
  const duplicate = trimmed !== "" && folders.some((folder) => folder.name === trimmed);
  const currentFolder = folders.find((folder) => folder.id === currentFolderId);

  const assign = (folderId: string) => {
    onAssign(folderId);
    onClose();
  };

  const createOrJoin = () => {
    if (!trimmed) return;
    if (duplicate) {
      const existing = folders.find((folder) => folder.name === trimmed);
      if (existing) assign(existing.id);
      return;
    }
    onCreateAndAssign(trimmed);
    onClose();
  };

  return (
    <Modal title="添加分组" onClose={onClose} width={400}>
      <div className={styles.body}>
        <p className={styles.roomLabel}>{roomLabel}</p>
        <p className={styles.empty}>分组与侧边栏关注列表的文件夹同步。</p>
        {folders.length > 0 ? (
          <div className={styles.groupList} role="listbox" aria-label="关注文件夹">
            {folders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                role="option"
                aria-selected={folder.id === currentFolderId}
                className={cn(
                  styles.groupItem,
                  folder.id === currentFolderId && styles.groupActive,
                )}
                onClick={() => assign(folder.id)}
              >
                <span>{folder.name}</span>
                {folder.id === currentFolderId && <Check size={15} />}
              </button>
            ))}
          </div>
        ) : (
          <p className={styles.empty}>还没有文件夹，输入名称创建第一个分组。</p>
        )}
        <div className={styles.createRow}>
          <input
            type="text"
            value={newGroup}
            maxLength={40}
            placeholder="新分组名称"
            aria-label="新分组名称"
            onChange={(event) => setNewGroup(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") createOrJoin();
            }}
          />
          <button
            type="button"
            className={styles.createButton}
            disabled={!trimmed}
            onClick={createOrJoin}
          >
            <FolderPlus size={15} />
            {duplicate ? "加入该分组" : "创建并加入"}
          </button>
        </div>
        {currentFolder && (
          <button
            type="button"
            className={styles.removeButton}
            onClick={() => {
              onRemove();
              onClose();
            }}
          >
            <X size={14} />
            移出文件夹「{currentFolder.name}」（回到顶层列表）
          </button>
        )}
      </div>
    </Modal>
  );
}
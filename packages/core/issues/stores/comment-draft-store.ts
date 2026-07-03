import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Attachment } from "../../types/attachment";
import { createWorkspaceAwareStorage, registerForWorkspaceRehydration } from "../../platform/workspace-storage";
import { defaultStorage } from "../../platform/storage";

/**
 * Per-comment draft persistence — survives:
 *  - virtualization unmount (the reason this exists: when a TipTap editor
 *    scrolls out of the Virtuoso viewport, its in-memory state is lost)
 *  - tab close / accidental Cmd-W
 *  - reload
 *
 * Keys are issue-scoped because createWorkspaceAwareStorage only partitions
 * by workspace, not by issue. Without issueId in the key, two issues with
 * thread replies open in adjacent desktop tabs would collide.
 */

export type CommentDraftKey =
  | `new:${string}`              // top-level CommentInput, key = `new:${issueId}`
  | `reply:${string}:${string}`  // ReplyInput inside a thread, key = `reply:${issueId}:${rootCommentId}`
  | `edit:${string}:${string}`;  // inline edit on existing comment, key = `edit:${issueId}:${commentId}`

interface CommentDraft {
  content: string;
  attachments?: Attachment[];
  updatedAt: number;
}

interface CommentDraftStore {
  drafts: Record<string, CommentDraft>;
  getDraft: (key: CommentDraftKey) => string | undefined;
  getDraftAttachments: (key: CommentDraftKey) => Attachment[];
  setDraft: (key: CommentDraftKey, content: string) => void;
  setDraftAttachments: (key: CommentDraftKey, attachments: Attachment[]) => void;
  addDraftAttachment: (key: CommentDraftKey, attachment: Attachment) => void;
  clearDraft: (key: CommentDraftKey) => void;
}

// Drafts older than 30 days are dropped on store init. Without TTL the store
// would accumulate every edit attempt across every issue indefinitely and
// slowly leak localStorage quota.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function isAttachmentDraft(value: unknown): value is Attachment {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { filename?: unknown }).filename === "string"
  );
}

function sanitizeDraft(value: unknown): CommentDraft {
  const draft =
    typeof value === "object" && value !== null
      ? (value as Partial<CommentDraft>)
      : {};
  const attachments = Array.isArray(draft.attachments)
    ? draft.attachments.filter(isAttachmentDraft)
    : [];
  return {
    content: typeof draft.content === "string" ? draft.content : "",
    updatedAt:
      typeof draft.updatedAt === "number" && Number.isFinite(draft.updatedAt)
        ? draft.updatedAt
        : 0,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function pruneStaleDrafts(
  drafts: Record<string, unknown> | undefined,
): Record<string, CommentDraft> {
  const cutoff = Date.now() - TTL_MS;
  const out: Record<string, CommentDraft> = {};
  for (const [k, raw] of Object.entries(drafts ?? {})) {
    const draft = sanitizeDraft(raw);
    if (
      draft.updatedAt >= cutoff &&
      (draft.content.trim().length > 0 || (draft.attachments?.length ?? 0) > 0)
    ) {
      out[k] = draft;
    }
  }
  return out;
}

export const useCommentDraftStore = create<CommentDraftStore>()(
  persist(
    (set, get) => ({
      drafts: {},
      getDraft: (key) => get().drafts[key]?.content,
      getDraftAttachments: (key) => get().drafts[key]?.attachments ?? [],
      setDraft: (key, content) =>
        set((s) => {
          const existing = s.drafts[key];
          const attachments = existing?.attachments;
          return {
            drafts: {
              ...s.drafts,
              [key]: {
                content,
                updatedAt: Date.now(),
                ...(attachments && attachments.length > 0 ? { attachments } : {}),
              },
            },
          };
        }),
      setDraftAttachments: (key, attachments) =>
        set((s) => {
          const existing = s.drafts[key];
          const sanitized = attachments.filter(isAttachmentDraft);
          const content = existing?.content ?? "";
          if (!content.trim() && sanitized.length === 0 && !existing) return s;
          const next = { ...s.drafts };
          if (!content.trim() && sanitized.length === 0) {
            delete next[key];
            return { drafts: next };
          }
          next[key] = {
            content,
            updatedAt: Date.now(),
            ...(sanitized.length > 0 ? { attachments: sanitized } : {}),
          };
          return { drafts: next };
        }),
      addDraftAttachment: (key, attachment) =>
        set((s) => {
          if (!attachment.id) return s;
          const existing = s.drafts[key];
          const attachments = existing?.attachments ?? [];
          const nextAttachments = attachments.some((a) => a.id === attachment.id)
            ? attachments.map((a) => (a.id === attachment.id ? attachment : a))
            : [...attachments, attachment];
          return {
            drafts: {
              ...s.drafts,
              [key]: {
                content: existing?.content ?? "",
                updatedAt: Date.now(),
                attachments: nextAttachments,
              },
            },
          };
        }),
      clearDraft: (key) =>
        set((s) => {
          if (!(key in s.drafts)) return s;
          const next = { ...s.drafts };
          delete next[key];
          return { drafts: next };
        }),
    }),
    {
      name: "multica_comment_drafts",
      storage: createJSONStorage(() => createWorkspaceAwareStorage(defaultStorage)),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.drafts = pruneStaleDrafts(state.drafts);
        }
      },
    },
  ),
);

registerForWorkspaceRehydration(() => useCommentDraftStore.persist.rehydrate());

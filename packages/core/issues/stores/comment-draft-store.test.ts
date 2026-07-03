import { beforeEach, describe, expect, it } from "vitest";
import type { Attachment } from "../../types";
import { useCommentDraftStore, type CommentDraftKey } from "./comment-draft-store";

function makeAttachment(id: string, overrides: Partial<Attachment> = {}): Attachment {
  return {
    id,
    workspace_id: "ws-1",
    issue_id: "issue-1",
    comment_id: null,
    chat_session_id: null,
    chat_message_id: null,
    uploader_type: "member",
    uploader_id: "user-1",
    filename: `${id}.txt`,
    url: `/uploads/${id}.txt`,
    download_url: `/api/attachments/${id}/download`,
    markdown_url: `/api/attachments/${id}/download`,
    content_type: "text/plain",
    size_bytes: 12,
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("comment draft store — attachments", () => {
  const draftKey = "new:issue-1" as CommentDraftKey;

  beforeEach(() => {
    useCommentDraftStore.setState({ drafts: {} });
  });

  it("deduplicates attachment drafts by id", () => {
    useCommentDraftStore
      .getState()
      .addDraftAttachment(draftKey, makeAttachment("att-1"));
    useCommentDraftStore.getState().addDraftAttachment(
      draftKey,
      makeAttachment("att-1", { filename: "updated.txt" }),
    );

    const attachments = useCommentDraftStore
      .getState()
      .getDraftAttachments(draftKey);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.filename).toBe("updated.txt");
  });

  it("keeps attachment records when the draft content changes", () => {
    useCommentDraftStore
      .getState()
      .addDraftAttachment(draftKey, makeAttachment("att-1"));

    useCommentDraftStore.getState().setDraft(draftKey, "updated markdown");

    expect(useCommentDraftStore.getState().getDraft(draftKey)).toBe(
      "updated markdown",
    );
    expect(
      useCommentDraftStore.getState().getDraftAttachments(draftKey),
    ).toHaveLength(1);
  });

  it("clearDraft clears both content and attachment records", () => {
    useCommentDraftStore.getState().setDraft(draftKey, "hello");
    useCommentDraftStore
      .getState()
      .addDraftAttachment(draftKey, makeAttachment("att-1"));

    useCommentDraftStore.getState().clearDraft(draftKey);

    expect(useCommentDraftStore.getState().getDraft(draftKey)).toBeUndefined();
    expect(useCommentDraftStore.getState().getDraftAttachments(draftKey)).toEqual(
      [],
    );
  });
});

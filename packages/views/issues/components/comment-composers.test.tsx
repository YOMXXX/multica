import { forwardRef, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { UploadResult } from "@multica/core/hooks/use-file-upload";
import type { Attachment } from "@multica/core/types";
import {
  useCommentDraftStore,
  type CommentDraftKey,
} from "@multica/core/issues/stores";
import { renderWithI18n } from "../../test/i18n";
import { CommentInput } from "./comment-input";
import { ReplyInput } from "./reply-input";

const uploadWithToast = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", () => ({
  api: {},
}));

vi.mock("@multica/core/hooks/use-file-upload", () => ({
  useFileUpload: () => ({ uploadWithToast }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorType, actorId }: { actorType: string; actorId: string }) => (
    <span data-testid="actor-avatar">
      {actorType}:{actorId}
    </span>
  ),
}));

vi.mock("../../editor", () => ({
  useFileDropZone: () => ({
    isDragOver: false,
    dropZoneProps: { "data-testid": "drop-zone" },
  }),
  FileDropOverlay: () => null,
  ContentEditor: forwardRef(function MockContentEditor(
    {
      defaultValue,
      onUpdate,
      placeholder,
      onUploadFile,
      largePasteMode,
      attachments,
    }: {
      defaultValue?: string;
      onUpdate?: (markdown: string) => void;
      placeholder?: string;
      onUploadFile?: (file: File) => Promise<UploadResult | null>;
      largePasteMode?: "codeBlock" | "file";
      attachments?: Attachment[];
    },
    ref: Ref<unknown>,
  ) {
    const valueRef = useRef(defaultValue ?? "");

    useImperativeHandle(ref, () => ({
      getMarkdown: () => valueRef.current,
      clearContent: () => {
        valueRef.current = "";
      },
      focus: () => {},
      blur: () => {},
      uploadFile: async (file: File) => {
        const result = await onUploadFile?.(file);
        if (!result) return;
        valueRef.current = `${valueRef.current}\n${result.url}`.trim();
        onUpdate?.(valueRef.current);
      },
      hasActiveUploads: () => false,
    }));

    return (
      <textarea
        data-testid="editor"
        data-large-paste-mode={largePasteMode ?? ""}
        data-attachment-count={attachments?.length ?? 0}
        defaultValue={defaultValue}
        placeholder={placeholder}
        onChange={(event) => {
          valueRef.current = event.target.value;
          onUpdate?.(event.target.value);
        }}
      />
    );
  }),
}));

function renderWithProviders(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function renderCommentInput(onSubmit = vi.fn().mockResolvedValue(true)) {
  const view = renderWithProviders(<CommentInput issueId="issue-1" onSubmit={onSubmit} />);
  return { ...view, onSubmit };
}

function renderReplyInput({
  onSubmit = vi.fn().mockResolvedValue(true),
  size = "sm",
  draftKey = "reply:issue-1:comment-1" as CommentDraftKey,
}: {
  onSubmit?: (content: string, attachmentIds?: string[], suppressAgentIds?: string[]) => Promise<boolean>;
  size?: "sm" | "default";
  draftKey?: CommentDraftKey;
} = {}) {
  const view = renderWithProviders(
    <ReplyInput
      issueId="issue-1"
      parentId="comment-1"
      avatarType="member"
      avatarId="user-1"
      onSubmit={onSubmit}
      size={size}
      draftKey={draftKey}
    />,
  );
  return { ...view, onSubmit };
}

function getSubmitButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelectorAll("button")[1];
  if (!button) throw new Error("Expected submit button to render");
  return button;
}

function getFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("Expected file input to render");
  return input;
}

function makeUploadResult(id: string): UploadResult {
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
    url: `/api/attachments/${id}/download`,
    download_url: `/api/attachments/${id}/download`,
    markdown_url: `/api/attachments/${id}/download`,
    content_type: "text/plain",
    size_bytes: 12,
    created_at: new Date(0).toISOString(),
    link: `/api/attachments/${id}/download`,
    markdownLink: `/api/attachments/${id}/download`,
  };
}

beforeEach(() => {
  uploadWithToast.mockReset();
  localStorage.clear();
  useCommentDraftStore.setState({ drafts: {} });
});

describe("comment composers", () => {
  it("renders the main comment composer without a manual expand control", () => {
    const { container } = renderCommentInput();

    expect(screen.getByPlaceholderText("Leave a comment...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeInTheDocument();
    expect(container.querySelectorAll("button")).toHaveLength(2);

    const shell = screen.getByTestId("drop-zone");
    expect(shell.className).not.toMatch(/max-h-/);
    expect(shell.className).not.toContain("h-[70vh]");
  });

  it("renders reply composer without a manual expand control", () => {
    const { container } = renderReplyInput();

    expect(screen.getByPlaceholderText("Leave a reply...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeInTheDocument();
    expect(container.querySelectorAll("button")).toHaveLength(2);

    const shell = screen.getByTestId("drop-zone");
    expect(shell.className).not.toMatch(/max-h-/);
    expect(shell.className).not.toContain("h-[60vh]");
  });

  it("enables large paste file mode for main comments and replies", () => {
    const comment = renderCommentInput();
    expect(screen.getByTestId("editor")).toHaveAttribute(
      "data-large-paste-mode",
      "file",
    );
    comment.unmount();

    renderReplyInput();
    expect(screen.getByTestId("editor")).toHaveAttribute(
      "data-large-paste-mode",
      "file",
    );
  });

  it("lets default-size replies grow without a height cap", () => {
    const { container } = renderReplyInput({ size: "default" });

    expect(screen.getByPlaceholderText("Leave a reply...")).toBeInTheDocument();
    expect(container.querySelectorAll("button")).toHaveLength(2);

    const shell = screen.getByTestId("drop-zone");
    expect(shell.className).not.toMatch(/max-h-/);
  });

  it("keeps main comment submission wired after removing expand", async () => {
    const { container, onSubmit } = renderCommentInput();

    fireEvent.change(screen.getByTestId("editor"), {
      target: { value: "hello from composer" },
    });
    fireEvent.click(getSubmitButton(container));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("hello from composer", undefined, undefined);
    });
  });

  it("persists uploaded main comment attachment drafts and submits active ids", async () => {
    const uploadResult = makeUploadResult("att-1");
    uploadWithToast.mockResolvedValue(uploadResult);
    const { container, onSubmit } = renderCommentInput();

    fireEvent.change(getFileInput(container), {
      target: {
        files: [
          new File(["payload"], "pasted-text.txt", { type: "text/plain" }),
        ],
      },
    });

    await waitFor(() =>
      expect(uploadWithToast).toHaveBeenCalledWith(expect.any(File), {
        issueId: "issue-1",
      }),
    );
    await waitFor(() =>
      expect(
        useCommentDraftStore
          .getState()
          .getDraftAttachments("new:issue-1"),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.getByTestId("editor")).toHaveAttribute(
        "data-attachment-count",
        "1",
      ),
    );

    fireEvent.click(getSubmitButton(container));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        "/api/attachments/att-1/download",
        ["att-1"],
        undefined,
      );
    });
  });

  it("keeps reply submission wired after removing expand", async () => {
    const { container, onSubmit } = renderReplyInput();

    fireEvent.change(screen.getByTestId("editor"), {
      target: { value: "thread reply" },
    });
    fireEvent.click(getSubmitButton(container));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("thread reply", undefined, undefined);
    });
  });

  it("locks the editor while the send is in flight, then clears on success", async () => {
    let resolveSubmit: (ok: boolean) => void = () => {};
    const onSubmit = vi.fn(
      () => new Promise<boolean>((resolve) => { resolveSubmit = resolve; }),
    );
    const { container } = renderCommentInput(onSubmit);

    fireEvent.change(screen.getByTestId("editor"), { target: { value: "sending" } });
    fireEvent.click(getSubmitButton(container));

    // In flight: text kept, editor wrapper locked (aria-busy), not cleared yet.
    await waitFor(() =>
      expect(screen.getByTestId("editor").closest("[aria-busy]")).toHaveAttribute(
        "aria-busy",
        "true",
      ),
    );
    expect(onSubmit).toHaveBeenCalledWith("sending", undefined, undefined);

    resolveSubmit(true);

    // Success: the composer clears (now empty → submit disabled, lock released).
    await waitFor(() => expect(getSubmitButton(container)).toBeDisabled());
    expect(screen.getByTestId("editor").closest("[aria-busy]")).toBeNull();
  });

  it("keeps the draft when the send fails (no optimistic clear)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    const { container } = renderCommentInput(onSubmit);

    fireEvent.change(screen.getByTestId("editor"), { target: { value: "will fail" } });
    fireEvent.click(getSubmitButton(container));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // Failed send must NOT clear — the box still has content, submit stays live.
    await waitFor(() => expect(getSubmitButton(container)).not.toBeDisabled());
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { createEditorExtensions } from ".";

let editor: Editor | null = null;

interface JsonNode {
  type?: string;
  text?: string;
  marks?: Array<{ type: string }>;
  content?: JsonNode[];
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

function makeProductionEditor(
  options: Partial<Parameters<typeof createEditorExtensions>[0]> = {},
): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: createEditorExtensions({
      placeholder: "",
      disableMentions: true,
      enableSlashCommands: false,
      onUploadFileRef: { current: undefined },
      ...options,
    }),
  });
}

function makeCodePasteRuleEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: [
      StarterKit,
      Markdown.configure({ indentation: { style: "space", size: 3 } }),
    ],
  });
}

function typeText(ed: Editor, text: string) {
  for (const ch of text) {
    const { from, to } = ed.state.selection;
    const handled = ed.view.someProp("handleTextInput", (handler) =>
      handler(ed.view, from, to, ch, () => ed.state.tr),
    );
    if (!handled) {
      ed.view.dispatch(ed.state.tr.insertText(ch, from, to));
    }
  }
}

function hasCodeMark(node: JsonNode): boolean {
  if (node.marks?.some((mark) => mark.type === "code")) return true;
  return (node.content ?? []).some(hasCodeMark);
}

function fakePasteEvent(text: string) {
  return {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  } as unknown as ClipboardEvent;
}

function paste(editor: Editor, text: string): boolean {
  const event = fakePasteEvent(text);
  return (
    editor.view.someProp("handlePaste", (handler) =>
      handler(editor.view, event, editor.view.state.selection.content()),
    ) === true
  );
}

function findFirst(json: JsonNode, type: string): JsonNode | undefined {
  if (json.type === type) return json;
  for (const child of json.content ?? []) {
    const hit = findFirst(child, type);
    if (hit) return hit;
  }
  return undefined;
}

function nodeText(node: JsonNode): string {
  if (node.text !== undefined) return node.text;
  return (node.content ?? []).map(nodeText).join("");
}

describe("inline code input rule", () => {
  it("preserves the character before an inline code shortcut", () => {
    editor = makeProductionEditor();

    typeText(editor, "abcd`123`");

    expect(editor.getText()).toBe("abcd123");
    expect(editor.getMarkdown().trim()).toBe("abcd`123`");
  });

  it("formats inline code at the start of a paragraph", () => {
    editor = makeProductionEditor();

    typeText(editor, "`123`");

    expect(editor.getText()).toBe("123");
    expect(editor.getMarkdown().trim()).toBe("`123`");
  });

  it("does not treat adjacent backticks as a single-backtick code shortcut", () => {
    editor = makeProductionEditor();

    typeText(editor, "``123``");

    expect(editor.getText()).toBe("``123``");
    expect(hasCodeMark(editor.getJSON() as JsonNode)).toBe(false);
  });
});

describe("inline code paste rule", () => {
  it("preserves the character before an inline code paste match", () => {
    editor = makeCodePasteRuleEditor();

    editor.view.dispatch(
      editor.state.tr.insertText("abcd`123`").setMeta("uiEvent", "paste"),
    );

    expect(editor.getText()).toBe("abcd123");
    expect(editor.getMarkdown().trim()).toBe("abcd`123`");
  });
});

describe("large text paste file mode", () => {
  it("defaults to a plain code block even when an upload handler exists", () => {
    const upload = vi.fn(async (_file: File) => null);
    editor = makeProductionEditor({
      onUploadFileRef: { current: upload },
    });
    const text = "large paste\n" + "payload\n".repeat(700);

    const handled = paste(editor, text);

    expect(handled).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    const codeBlock = findFirst(editor.getJSON() as JsonNode, "codeBlock");
    expect(codeBlock).toBeDefined();
    expect(nodeText(codeBlock!)).toBe(text);
  });

  it("creates pasted-text.txt only when largePasteMode is file", () => {
    const upload = vi.fn(async (_file: File) => null);
    editor = makeProductionEditor({
      largePasteMode: "file",
      onUploadFileRef: { current: upload },
    });
    const text = "large paste\n" + "payload\n".repeat(700);

    const handled = paste(editor, text);

    expect(handled).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    const file = upload.mock.calls[0]?.[0] as File;
    expect(file.name).toBe("pasted-text.txt");
    expect(file.type).toBe("text/plain");
  });
});

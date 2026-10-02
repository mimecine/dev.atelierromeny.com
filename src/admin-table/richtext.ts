// WYSIWYG markdown editor in a dialog, built on Lexical (the editor Sveltia CMS uses).
// Content goes in and comes out as markdown; a "Markdown" tab edits the source directly.
// Images (![alt](src "caption")) are kept as their own node so they survive editing.
import {
  $createParagraphNode,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  DROP_COMMAND,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
  createEditor,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { $createHeadingNode, $createQuoteNode, HeadingNode, QuoteNode, registerRichText } from "@lexical/rich-text";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
  REMOVE_LIST_COMMAND,
  registerList,
} from "@lexical/list";
import { $isLinkNode, $toggleLink, LinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { CodeNode } from "@lexical/code";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  ITALIC_UNDERSCORE,
  TRANSFORMERS,
  registerMarkdownShortcuts,
  type TextMatchTransformer,
} from "@lexical/markdown";
import { $setBlocksType } from "@lexical/selection";
import { mergeRegister } from "@lexical/utils";

export interface RichTextOptions {
  title: string;
  /** Show a stored image path ("/src/media/…") in an <img>. */
  showImage: (path: string, img: HTMLImageElement) => void;
  /** Stage dropped/picked image files; resolves to their stored paths. */
  uploadImages: (files: File[]) => Promise<string[]>;
}

let options: RichTextOptions;

// ---------------------------------------------------------------- image node

type SerializedImageNode = Spread<{ src: string; alt: string; caption: string }, SerializedLexicalNode>;

class ImageNode extends DecoratorNode<null> {
  __src: string;
  __alt: string;
  __caption: string;

  static getType() {
    return "md-image";
  }
  static clone(node: ImageNode) {
    return new ImageNode(node.__src, node.__alt, node.__caption, node.__key);
  }
  static importJSON(json: SerializedImageNode) {
    return new ImageNode(json.src, json.alt, json.caption);
  }
  constructor(src: string, alt = "", caption = "", key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__alt = alt;
    this.__caption = caption;
  }
  exportJSON(): SerializedImageNode {
    return { type: "md-image", version: 1, src: this.__src, alt: this.__alt, caption: this.__caption };
  }
  createDOM(_config: EditorConfig) {
    const figure = document.createElement("span");
    figure.className = "rt-image";
    const img = document.createElement("img");
    img.alt = this.__alt;
    options.showImage(this.__src, img);
    figure.append(img);
    if (this.__caption) {
      const cap = document.createElement("span");
      cap.className = "rt-caption";
      cap.textContent = this.__caption;
      figure.append(cap);
    }
    return figure;
  }
  updateDOM() {
    return false;
  }
  decorate() {
    return null;
  }
}

const $createImageNode = (src: string, alt = "", caption = "") => new ImageNode(src, alt, caption);
const $isImageNode = (node: LexicalNode | null | undefined): node is ImageNode => node instanceof ImageNode;

const IMAGE: TextMatchTransformer = {
  dependencies: [ImageNode],
  export: (node) =>
    $isImageNode(node) ? `![${node.__alt}](${node.__src}${node.__caption ? ` "${node.__caption.replace(/"/g, "'")}"` : ""})` : null,
  importRegExp: /!\[([^\]]*)\]\(([^()\s]+)(?:\s+"([^"]*)")?\)/,
  regExp: /!\[([^\]]*)\]\(([^()\s]+)(?:\s+"([^"]*)")?\)$/,
  replace: (textNode, match) => {
    textNode.replace($createImageNode(match[2], match[1], match[3] ?? ""));
  },
  trigger: ")",
  type: "text-match",
};

// Images first, or the link rule would read ![alt](src) as a link. Italics are written
// as _text_ (like Sveltia and the existing content), so ITALIC_UNDERSCORE goes first.
const MARKDOWN = [IMAGE, ITALIC_UNDERSCORE, ...TRANSFORMERS.filter((t) => t !== ITALIC_UNDERSCORE)];

// ---------------------------------------------------------------- dialog

const toMarkdown = (editor: LexicalEditor) => editor.getEditorState().read(() => $convertToMarkdownString(MARKDOWN));
const fromMarkdown = (editor: LexicalEditor, md: string) =>
  editor.update(() => $convertFromMarkdownString(md, MARKDOWN), { discrete: true });

function blockType(editor: LexicalEditor, type: "p" | "h2" | "h3" | "quote") {
  editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    $setBlocksType(selection, () =>
      type === "p" ? $createParagraphNode() : type === "quote" ? $createQuoteNode() : $createHeadingNode(type)
    );
  });
}

function insertImages(editor: LexicalEditor, paths: string[]) {
  editor.update(() => {
    const nodes = paths.map((p) => $createImageNode(p, p.split("/").pop()!.replace(/\.[^.]+$/, "")));
    $insertNodes(nodes);
  });
}

/** Opens the editor; resolves with the new markdown, or null when cancelled. */
export function editMarkdown(initial: string, opts: RichTextOptions): Promise<string | null> {
  options = opts;
  return new Promise((resolve) => {
    const content = document.createElement("div");
    content.className = "rt-content";
    content.contentEditable = "true";
    const source = document.createElement("textarea");
    source.className = "md-editor";
    source.hidden = true;

    const editor = createEditor({
      namespace: "atelier-table",
      nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode, ImageNode],
      onError: (e) => console.error(e),
      theme: {
        text: { bold: "rt-bold", italic: "rt-italic", underline: "rt-underline", code: "rt-code" },
        link: "rt-link",
        quote: "rt-quote",
        heading: { h1: "rt-h1", h2: "rt-h2", h3: "rt-h3" },
        list: { ul: "rt-ul", ol: "rt-ol", listitem: "rt-li" },
        paragraph: "rt-p",
      },
    });
    editor.setRootElement(content);
    const cleanup = mergeRegister(
      registerRichText(editor),
      registerHistory(editor, createEmptyHistoryState(), 300),
      registerList(editor),
      // (registerLink is tied to Lexical's extension system; the link button only needs this)
      editor.registerCommand(
        TOGGLE_LINK_COMMAND,
        (url: string | null) => {
          $toggleLink(url);
          return true;
        },
        COMMAND_PRIORITY_LOW
      ),
      registerMarkdownShortcuts(editor, MARKDOWN),
      editor.registerCommand(
        DROP_COMMAND,
        (event: DragEvent) => {
          const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (!files.length) return false;
          event.preventDefault();
          opts.uploadImages(files).then((paths) => paths.length && insertImages(editor, paths));
          return true;
        },
        COMMAND_PRIORITY_LOW
      )
    );
    fromMarkdown(editor, initial);
    const startMarkdown = toMarkdown(editor);

    let mode: "rich" | "md" = "rich";
    const setMode = (next: "rich" | "md") => {
      if (next === mode) return;
      if (next === "md") source.value = toMarkdown(editor);
      else fromMarkdown(editor, source.value);
      mode = next;
      content.hidden = mode !== "rich";
      toolbar.hidden = mode !== "rich";
      source.hidden = mode !== "md";
      tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    };

    const button = (label: string, title: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = label;
      b.title = title;
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
      b.addEventListener("click", run);
      return b;
    };
    const toolbar = document.createElement("div");
    toolbar.className = "rt-toolbar";
    toolbar.append(
      button("<b>B</b>", "Bold (⌘B)", () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")),
      button("<i>I</i>", "Italic (⌘I)", () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")),
      button("¶", "Paragraph", () => blockType(editor, "p")),
      button("H2", "Heading", () => blockType(editor, "h2")),
      button("H3", "Subheading", () => blockType(editor, "h3")),
      button("❝", "Quote", () => blockType(editor, "quote")),
      button("•", "Bulleted list", () => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)),
      button("1.", "Numbered list", () => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)),
      button("✕•", "Remove list", () => editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined)),
      button("🔗", "Link", () => {
        let current = "";
        editor.getEditorState().read(() => {
          const s = $getSelection();
          const node = $isRangeSelection(s) ? s.anchor.getNode() : null;
          const link = node && ($isLinkNode(node) ? node : node.getParent());
          if (link && $isLinkNode(link)) current = link.getURL();
        });
        const url = prompt("Link address (empty to remove the link)", current || "https://");
        if (url === null) return;
        editor.dispatchCommand(TOGGLE_LINK_COMMAND, url.trim() && url.trim() !== "https://" ? url.trim() : null);
      }),
      button("🖼", "Insert image", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.multiple = true;
        input.addEventListener("change", async () => {
          const paths = await opts.uploadImages([...(input.files ?? [])]);
          if (paths.length) insertImages(editor, paths);
        });
        input.click();
      }),
      button("↶", "Undo (⌘Z)", () => editor.dispatchCommand(UNDO_COMMAND, undefined)),
      button("↷", "Redo (⇧⌘Z)", () => editor.dispatchCommand(REDO_COMMAND, undefined))
    );

    const tabs = document.createElement("div");
    tabs.className = "rt-tabs";
    for (const [m, label] of [["rich", "Rich text"], ["md", "Markdown"]] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.mode = m;
      b.textContent = label;
      b.className = m === "rich" ? "on" : "";
      b.addEventListener("click", () => setMode(m));
      tabs.append(b);
    }

    const heading = document.createElement("div");
    heading.className = "rt-head";
    const h2 = document.createElement("h2");
    h2.textContent = opts.title;
    heading.append(h2, tabs);

    const dialog = document.createElement("dialog");
    dialog.className = "modal rt-modal";
    const buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    let result: string | null = null;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => dialog.close());
    const done = document.createElement("button");
    done.type = "button";
    done.className = "primary";
    done.textContent = "Done";
    done.addEventListener("click", () => {
      const md = mode === "md" ? source.value : toMarkdown(editor);
      // Unchanged content keeps its original formatting; changed content keeps the
      // original's leading/trailing blank lines.
      if (md !== startMarkdown) {
        const lead = initial.match(/^\s*/)![0], trail = initial.match(/\s*$/)![0];
        result = lead + md.trim() + trail;
      }
      dialog.close();
    });
    buttons.append(cancel, done);

    dialog.append(heading, toolbar, content, source, buttons);
    dialog.addEventListener("close", () => {
      cleanup();
      editor.setRootElement(null);
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    content.focus();
  });
}

/** Markdown -> editor -> markdown without a dialog (used to check round trips). */
export const markdownRoundTrip = (md: string) => {
  options ??= { title: "", showImage: () => {}, uploadImages: async () => [] };
  const editor = createEditor({ nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode, ImageNode], onError: (e) => { throw e; } });
  fromMarkdown(editor, md);
  return toMarkdown(editor);
};

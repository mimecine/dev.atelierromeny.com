// Straighten & crop page: pick a work and one of its photos, point out the corners, save the
// result as an extra photo (one commit). The cropper itself is in cropper.ts. Works with
// whatever Sveltia is signed in with (see backend.ts).
import { parse as parseYaml } from "yaml";
import type { Repo } from "./github";
import { githubBackend, localBackend, sveltiaFolderHandle, sveltiaUser, type Backend } from "./backend";
import { parseEntry, serializeEntry, type Entry } from "./model";
import { createCropper } from "./cropper";

const WORKS = "src/content/works";
const MEDIA = "src/media/works";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

function h(tag: string, attrs: Record<string, any> = {}, ...kids: (Node | string | null | false)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = String(v);
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c != null && c !== false) el.append(c);
  return el;
}

function status(text: string, kind = "", link?: { href: string; text: string }) {
  const el = $("#status");
  el.className = `status ${kind}`;
  el.textContent = text;
  if (link) el.append(" ", h("a", { href: link.href, target: "_blank", rel: "noopener" }, link.text));
}

interface Work {
  entry: Entry;
  slug: string;
  title: string;
  label: string;
}

const state = { backend: undefined as unknown as Backend, repo: { owner: "", name: "", branch: "main" } as Repo, works: [] as Work[], work: undefined as Work | undefined };

const imagesOf = (e: Entry): string[] => (Array.isArray(e.data.images) ? e.data.images.filter(Boolean).map(String) : []);
const isDetail = (p: string) => /-detail(\.[\w-]+)?\.webp(\?.*)?$/.test(p);

const cropper = createCropper({
  readPhoto: (path) => state.backend.readBlob(path.replace(/^\//, "")),
  actions: [
    {
      label: "Save as an extra photo",
      primary: true,
      async run(blob) {
        const work = state.work;
        if (!work) throw new Error("Pick a work to save to first.");
        const entry = work.entry;
        const taken = new Set([...(await state.backend.listFolder(MEDIA)), ...imagesOf(entry).map((p) => p.split("/").pop()!)]);
        let name = `${work.slug}-crop.webp`;
        for (let i = 2; taken.has(name); i++) name = `${work.slug}-crop-${i}.webp`;
        const repoPath = `${MEDIA}/${name}`;
        const images = imagesOf(entry);
        // just before the detail, so the detail stays last
        images.splice(images.length && isDetail(images[images.length - 1]) ? images.length - 1 : images.length, 0, `/${repoPath}`);
        entry.data.images = images;
        entry.dirty.add("images");
        const text = serializeEntry(entry);
        cropper.setStatus("Saving…");
        try {
          const result = await state.backend.save(
            [{ path: repoPath, blob }, { path: entry.path, text, original: entry.original }],
            `Straightened photo for ${work.title || work.slug}`
          );
          await state.backend.remember(WORKS, [{ name: entry.name, text }]);
          const fresh = parseEntry(entry.name, entry.path, text);
          Object.assign(entry, { original: text, doc: fresh.doc, body: fresh.body, data: fresh.data, dirty: new Set() });
          cropper.setPhotos(imagesOf(entry));
          if (state.backend.kind === "local") cropper.setStatus(`Saved as ${name}. Commit and push it when you're ready.`, "ok");
          else cropper.setStatus(`Saved as ${name}. The site rebuilds in a few minutes. `, "ok", result.url ? { href: result.url, text: "View commit" } : undefined);
        } catch (err) {
          entry.dirty.clear();
          entry.data.images = imagesOf(parseEntry(entry.name, entry.path, entry.original));
          throw err;
        }
      },
    },
  ],
});

async function chooseWork(label: string) {
  const work = state.works.find((w) => w.label === label) ?? state.works.find((w) => w.slug === label || w.title.toLowerCase() === label.toLowerCase());
  if (!work) return;
  state.work = work;
  try {
    localStorage.setItem("atelier-crop.work", work.slug);
  } catch {}
  history.replaceState(null, "", `?work=${encodeURIComponent(work.slug)}`);
  $<HTMLInputElement>("#work").value = work.label;
  const images = imagesOf(work.entry);
  cropper.setPhotos(images, images.find((p) => !isDetail(p)) ?? images[0]);
}

async function connectBackend(): Promise<Backend | undefined> {
  const user = sveltiaUser();
  if (user?.backendName === "github" && user.token) return githubBackend(user.token, state.repo);
  if (user?.backendName === "local") {
    if (!("showDirectoryPicker" in window)) {
      status("Local repositories need Chrome or Edge, like Sveltia's local mode.", "error");
      return;
    }
    const handle = await sveltiaFolderHandle(state.repo);
    const granted = async (d: FileSystemDirectoryHandle) =>
      (await (d as any).queryPermission({ mode: "readwrite" })) === "granted" ||
      (await (d as any).requestPermission({ mode: "readwrite" })) === "granted";
    if (handle && (await (handle as any).queryPermission({ mode: "readwrite" })) === "granted") return localBackend(handle);
    return new Promise((resolve) => {
      const allow = h("button", { type: "button" }, handle ? `Open local folder “${handle.name}”` : "Choose the project folder");
      allow.addEventListener("click", async () => {
        try {
          const dir = handle ?? ((await (window as any).showDirectoryPicker({ mode: "readwrite" })) as FileSystemDirectoryHandle);
          if (await granted(dir)) resolve(localBackend(dir));
        } catch (e) {
          status(String((e as Error).message ?? e), "error");
        }
      });
      status("Sveltia is working with a local repository. Allow this page to use the same folder: ");
      $("#status").append(allow);
    });
  }
  status("Sign in to Sveltia first (GitHub or a local repository) to save; you can still straighten a photo from your computer.", "error", { href: "/admin/", text: "Open the CMS" });
}

async function start() {
  $("#host").append(cropper.el);
  cropper.layout();
  const config = parseYaml(await (await fetch("/admin/config.yml")).text());
  const [owner, name] = String(config.backend.repo).split("/");
  state.repo = { owner, name, branch: config.backend.branch ?? "main" };
  const backend = await connectBackend();
  if (!backend) return;
  state.backend = backend;
  $("#backend").textContent = backend.label;
  status("Loading the works…");
  const files = await backend.loadFolder(WORKS);
  state.works = files
    .filter((f) => f.name.endsWith(".md"))
    .map((f) => parseEntry(f.name, `${WORKS}/${f.name}`, f.text))
    .map((entry) => {
      const title = String(entry.data.title ?? "");
      return { entry, slug: entry.slug, title, label: `${title && title !== "null" ? title : "No title recorded"} — ${entry.slug}` };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  $("#works").replaceChildren(...state.works.map((w) => h("option", { value: w.label })));
  $("#work").addEventListener("change", (e) => chooseWork((e.target as HTMLInputElement).value));
  status("");
  let wanted = new URLSearchParams(location.search).get("work");
  try {
    wanted ??= localStorage.getItem("atelier-crop.work");
  } catch {}
  const w = state.works.find((x) => x.slug === wanted);
  if (w) await chooseWork(w.label);
}

start().catch((e) => status(String(e.message ?? e), "error"));

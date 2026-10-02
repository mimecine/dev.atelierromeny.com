// Where the table view reads and writes: whatever Sveltia CMS is using.
//  - GitHub: Sveltia's token (localStorage "sveltia-cms.user"); every save is one commit.
//  - Local repository: the folder Sveltia was given ("Work with Local Repository"),
//    whose handle Sveltia keeps in IndexedDB; files are written directly and you commit
//    them yourself, exactly as with Sveltia.
import {
  ConflictError,
  blobToBase64,
  commit,
  fetchRaw,
  listFolder,
  loadFiles,
  loadFolder,
  utf8ToBase64,
  type Repo,
  type RepoFile,
} from "./github";

export { ConflictError };

export interface Change {
  path: string;
  /** new text for a content file, with the text it had when loaded */
  text?: string;
  original?: string;
  /** an uploaded file */
  blob?: Blob;
}

export interface Backend {
  kind: "github" | "local";
  label: string;
  loadFolder(folder: string): Promise<RepoFile[]>;
  /** File names in a folder (e.g. a media folder), without reading them. */
  listFolder(folder: string): Promise<string[]>;
  readBlob(path: string): Promise<Blob>;
  /** Writes everything or nothing; throws if an edited file changed since it was loaded. */
  save(changes: Change[], message: string): Promise<{ url?: string }>;
}

interface SveltiaUser {
  backendName?: string;
  token?: string;
}

export function sveltiaUser(): SveltiaUser | undefined {
  try {
    return JSON.parse(localStorage.getItem("sveltia-cms.user") || "null") ?? undefined;
  } catch {
    return undefined;
  }
}

const clashError = (paths: string[]) =>
  new ConflictError(
    `${paths.map((p) => p.split("/").pop()).join(", ")} changed elsewhere since this page loaded. ` +
      `Copy your edits, reload, and apply them again.`
  );

// ---------------------------------------------------------------- GitHub

export function githubBackend(token: string, repo: Repo): Backend {
  let headOid = "";
  return {
    kind: "github",
    label: `GitHub · ${repo.owner}/${repo.name}`,
    async loadFolder(folder) {
      const r = await loadFolder(token, repo, folder);
      headOid = r.headOid;
      return r.files;
    },
    listFolder: (folder) => listFolder(token, repo, folder),
    readBlob: (path) => fetchRaw(token, repo, path),
    async save(changes, message) {
      const additions = await Promise.all(
        changes.map(async (c) => ({ path: c.path, contents: c.blob ? await blobToBase64(c.blob) : utf8ToBase64(c.text ?? "") }))
      );
      try {
        const r = await commit(token, repo, headOid, message, additions);
        headOid = r.oid;
        return { url: r.url };
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        // Someone committed in the meantime (e.g. in Sveltia). Retry only if none of
        // the files we're about to write changed.
        const edited = changes.filter((c) => c.text != null);
        const { headOid: latest, texts } = await loadFiles(token, repo, edited.map((c) => c.path));
        const clashes = edited.filter((c) => texts.get(c.path) !== c.original).map((c) => c.path);
        if (clashes.length) throw clashError(clashes);
        headOid = latest;
        const r = await commit(token, repo, headOid, message, additions);
        headOid = r.oid;
        return { url: r.url };
      }
    },
  };
}

// ---------------------------------------------------------------- local folder

/** The folder handle Sveltia stored for this repository, if any. */
export async function sveltiaFolderHandle(repo: Repo): Promise<FileSystemDirectoryHandle | undefined> {
  const dbName = `github:${repo.owner}/${repo.name}`;
  return new Promise((resolve) => {
    const open = indexedDB.open(dbName);
    open.onupgradeneeded = () => open.transaction?.abort(); // don't create Sveltia's database
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("file-system-handles")) {
        db.close();
        return resolve(undefined);
      }
      const get = db.transaction("file-system-handles").objectStore("file-system-handles").get("root_dir_handle");
      get.onsuccess = () => {
        db.close();
        resolve(get.result ?? undefined);
      };
      get.onerror = () => {
        db.close();
        resolve(undefined);
      };
    };
  });
}

async function dirAt(root: FileSystemDirectoryHandle, path: string, create = false) {
  let dir = root;
  for (const part of path.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

async function fileAt(root: FileSystemDirectoryHandle, path: string, create = false) {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop()!;
  return (await dirAt(root, parts.join("/"), create)).getFileHandle(name, { create });
}

async function readText(root: FileSystemDirectoryHandle, path: string) {
  try {
    return await (await (await fileAt(root, path)).getFile()).text();
  } catch {
    return null;
  }
}

export function localBackend(root: FileSystemDirectoryHandle): Backend {
  return {
    kind: "local",
    label: `Local folder · ${root.name}`,
    async loadFolder(folder) {
      const dir = await dirAt(root, folder);
      const files: RepoFile[] = [];
      for await (const [name, handle] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
        if (handle.kind === "file") files.push({ name, text: await (await (handle as FileSystemFileHandle).getFile()).text() });
      }
      return files;
    },
    async listFolder(folder) {
      const names: string[] = [];
      try {
        const dir = await dirAt(root, folder);
        for await (const [name, handle] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
          if (handle.kind === "file") names.push(name);
        }
      } catch {
        // folder doesn't exist yet
      }
      return names;
    },
    async readBlob(path) {
      return (await fileAt(root, path)).getFile();
    },
    async save(changes) {
      const edited = changes.filter((c) => c.text != null);
      const clashes: string[] = [];
      for (const c of edited) if ((await readText(root, c.path)) !== c.original) clashes.push(c.path);
      if (clashes.length) throw clashError(clashes);
      for (const c of changes) {
        const writable = await (await fileAt(root, c.path, true)).createWritable();
        await writable.write(c.blob ?? c.text ?? "");
        await writable.close();
      }
      return {};
    },
  };
}

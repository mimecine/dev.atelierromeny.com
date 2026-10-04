// GitHub API calls for the table view (see backend.ts): reading a folder with its
// files in one request, and saving as a single commit, the way Sveltia CMS does.

export interface Repo {
  owner: string;
  name: string;
  branch: string;
}

export class ConflictError extends Error {}

async function gql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) throw new Error("GitHub rejected the login. Sign in again at /admin/.");
  const json = await res.json();
  if (json.errors?.length) {
    const message = json.errors.map((e: { message: string }) => e.message).join("; ");
    if (/expected.*head|is not the head|branch to point/i.test(message)) throw new ConflictError(message);
    throw new Error(message);
  }
  return json.data as T;
}

export interface RepoFile {
  name: string;
  text: string;
  /** Git object id, when read from GitHub */
  oid?: string;
}

/** Every file in `folder` (not recursive) with its text, plus the branch head. */
export async function loadFolder(token: string, repo: Repo, folder: string) {
  const data = await gql<{
    repository: {
      ref: { target: { oid: string } } | null;
      object: { entries: { name: string; type: string; oid: string; object: { text: string | null } | null }[] } | null;
    };
  }>(
    token,
    `query($owner: String!, $name: String!, $ref: String!, $expr: String!) {
      repository(owner: $owner, name: $name) {
        ref(qualifiedName: $ref) { target { oid } }
        object(expression: $expr) {
          ... on Tree { entries { name type oid object { ... on Blob { text } } } }
        }
      }
    }`,
    { owner: repo.owner, name: repo.name, ref: `refs/heads/${repo.branch}`, expr: `${repo.branch}:${folder}` }
  );
  const headOid = data.repository.ref?.target.oid;
  if (!headOid) throw new Error(`Branch ${repo.branch} not found`);
  const files: RepoFile[] = (data.repository.object?.entries ?? [])
    .filter((e) => e.type === "blob" && e.object?.text != null)
    .map((e) => ({ name: e.name, text: e.object!.text!, oid: e.oid }));
  return { headOid, files };
}

/** Names and Git object ids of the files in `folder`, plus the branch head. */
export async function folderIndex(token: string, repo: Repo, folder: string) {
  const data = await gql<{
    repository: {
      ref: { target: { oid: string } } | null;
      object: { entries: { name: string; type: string; oid: string }[] } | null;
    };
  }>(
    token,
    `query($owner: String!, $name: String!, $ref: String!, $expr: String!) {
      repository(owner: $owner, name: $name) {
        ref(qualifiedName: $ref) { target { oid } }
        object(expression: $expr) { ... on Tree { entries { name type oid } } }
      }
    }`,
    { owner: repo.owner, name: repo.name, ref: `refs/heads/${repo.branch}`, expr: `${repo.branch}:${folder}` }
  );
  const headOid = data.repository.ref?.target.oid;
  if (!headOid) throw new Error(`Branch ${repo.branch} not found`);
  return { headOid, entries: (data.repository.object?.entries ?? []).filter((e) => e.type === "blob") };
}

/** Texts of blobs by object id, 100 per request. */
export async function blobTexts(token: string, repo: Repo, oids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < oids.length; i += 100) {
    const batch = oids.slice(i, i + 100);
    const fields = batch.map((oid, j) => `b${j}: object(oid: "${oid}") { ... on Blob { text } }`).join("\n");
    const data = await gql<{ repository: Record<string, { text: string | null } | null> }>(
      token,
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
      { owner: repo.owner, name: repo.name }
    );
    batch.forEach((oid, j) => {
      const text = data.repository[`b${j}`]?.text;
      if (text != null) out.set(oid, text);
    });
  }
  return out;
}

/** File names in `folder` (no contents; cheap even for image folders). */
export async function listFolder(token: string, repo: Repo, folder: string): Promise<string[]> {
  const data = await gql<{ repository: { object: { entries: { name: string; type: string }[] } | null } }>(
    token,
    `query($owner: String!, $name: String!, $expr: String!) {
      repository(owner: $owner, name: $name) {
        object(expression: $expr) { ... on Tree { entries { name type } } }
      }
    }`,
    { owner: repo.owner, name: repo.name, expr: `${repo.branch}:${folder}` }
  );
  return (data.repository.object?.entries ?? []).filter((e) => e.type === "blob").map((e) => e.name);
}

/** Current text of a few files (for checking what changed elsewhere before a retry). */
export async function loadFiles(token: string, repo: Repo, paths: string[]) {
  const fields = paths
    .map((p, i) => `f${i}: object(expression: ${JSON.stringify(`${repo.branch}:${p}`)}) { ... on Blob { text } }`)
    .join("\n");
  const data = await gql<{ repository: Record<string, { text: string } | null> & { ref: { target: { oid: string } } } }>(
    token,
    `query($owner: String!, $name: String!, $ref: String!) {
      repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { target { oid } } ${fields} }
    }`,
    { owner: repo.owner, name: repo.name, ref: `refs/heads/${repo.branch}` }
  );
  const texts = new Map<string, string | null>();
  paths.forEach((p, i) => texts.set(p, data.repository[`f${i}`]?.text ?? null));
  return { headOid: data.repository.ref.target.oid, texts };
}

export interface Addition {
  path: string;
  /** base64 */
  contents: string;
}

/** One commit with all additions; fails with ConflictError if the branch moved. */
export async function commit(token: string, repo: Repo, expectedHeadOid: string, headline: string, additions: Addition[]) {
  const data = await gql<{ createCommitOnBranch: { commit: { oid: string; url: string } } }>(
    token,
    `mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { oid url } }
    }`,
    {
      input: {
        branch: { repositoryNameWithOwner: `${repo.owner}/${repo.name}`, branchName: repo.branch },
        message: { headline },
        expectedHeadOid,
        fileChanges: { additions },
      },
    }
  );
  return data.createCommitOnBranch.commit;
}

/** A file's bytes, for showing images that aren't in the build's thumbnail list yet. */
export async function fetchRaw(token: string, repo: Repo, path: string): Promise<Blob> {
  const res = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(repo.branch)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw" } }
  );
  if (!res.ok) throw new Error(`${res.status} for ${path}`);
  return res.blob();
}

export const utf8ToBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

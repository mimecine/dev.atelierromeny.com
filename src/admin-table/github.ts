// GitHub access for the table view. It reuses the token Sveltia CMS keeps in
// localStorage ("sveltia-cms.user"), so signing in to /admin/ is all that's needed,
// and writes the same way Sveltia does: one commit per save on the configured branch.

export interface Repo {
  owner: string;
  name: string;
  branch: string;
}

export class ConflictError extends Error {}

export function getToken(): string | undefined {
  try {
    const user = JSON.parse(localStorage.getItem("sveltia-cms.user") || "null");
    return user?.backendName === "github" && typeof user.token === "string" ? user.token : undefined;
  } catch {
    return undefined;
  }
}

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
}

/** Every file in `folder` (not recursive) with its text, plus the branch head. */
export async function loadFolder(token: string, repo: Repo, folder: string) {
  const data = await gql<{
    repository: {
      ref: { target: { oid: string } } | null;
      object: { entries: { name: string; type: string; object: { text: string | null } | null }[] } | null;
    };
  }>(
    token,
    `query($owner: String!, $name: String!, $ref: String!, $expr: String!) {
      repository(owner: $owner, name: $name) {
        ref(qualifiedName: $ref) { target { oid } }
        object(expression: $expr) {
          ... on Tree { entries { name type object { ... on Blob { text } } } }
        }
      }
    }`,
    { owner: repo.owner, name: repo.name, ref: `refs/heads/${repo.branch}`, expr: `${repo.branch}:${folder}` }
  );
  const headOid = data.repository.ref?.target.oid;
  if (!headOid) throw new Error(`Branch ${repo.branch} not found`);
  const files: RepoFile[] = (data.repository.object?.entries ?? [])
    .filter((e) => e.type === "blob" && e.object?.text != null)
    .map((e) => ({ name: e.name, text: e.object!.text! }));
  return { headOid, files };
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

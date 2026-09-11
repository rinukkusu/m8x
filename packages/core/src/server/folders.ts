import { prisma } from './db.js';

/**
 * Folder tree operations.
 *
 * `Folder.path` holds the ids of a folder's ancestors, e.g. "/a/b/". A folder's
 * own subtree is then everything whose path starts with `${folder.path}${id}/`,
 * which is one indexed prefix scan. The cost of that is here: every move has to
 * rewrite the path of the whole subtree, in a transaction.
 */

export const ROOT_PATH = '/';

export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  workflowCount: number;
  children: FolderNode[];
}

/** The full tree, with workflow counts. Small enough to fetch in one go. */
export async function getFolderTree(): Promise<FolderNode[]> {
  const [folders, counts] = await Promise.all([
    prisma.folder.findMany({ orderBy: [{ path: 'asc' }, { name: 'asc' }] }),
    prisma.workflow.groupBy({ by: ['folderId'], _count: { _all: true } }),
  ]);

  const countByFolder = new Map(counts.map((row) => [row.folderId, row._count._all]));

  const nodes = new Map<string, FolderNode>(
    folders.map((folder) => [
      folder.id,
      {
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        path: folder.path,
        workflowCount: countByFolder.get(folder.id) ?? 0,
        children: [],
      },
    ]),
  );

  const roots: FolderNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

export async function createFolder(name: string, parentId: string | null): Promise<string> {
  const parentPath = await resolveChildPath(parentId);
  const folder = await prisma.folder.create({
    data: { name: name.trim(), parentId, path: parentPath },
  });
  return folder.id;
}

/**
 * Move a folder, rewriting the materialised path of everything beneath it.
 *
 * Guards against making a folder its own ancestor. Without that check the
 * subtree would detach from the root and stop appearing anywhere in the UI,
 * with its rows still sitting in the table.
 */
export async function moveFolder(folderId: string, newParentId: string | null): Promise<void> {
  const folder = await prisma.folder.findUniqueOrThrow({ where: { id: folderId } });
  if (folder.parentId === newParentId) return;

  const oldPrefix = `${folder.path}${folder.id}/`;

  if (newParentId) {
    const target = await prisma.folder.findUniqueOrThrow({ where: { id: newParentId } });
    if (newParentId === folderId || `${target.path}${target.id}/`.startsWith(oldPrefix)) {
      throw new Error('A folder cannot be moved inside itself.');
    }
  }

  const newParentPath = await resolveChildPath(newParentId);
  const newPrefix = `${newParentPath}${folder.id}/`;

  await prisma.$transaction(async (tx) => {
    await tx.folder.update({
      where: { id: folderId },
      data: { parentId: newParentId, path: newParentPath },
    });

    // One statement for the whole subtree. Doing this row by row would be
    // O(subtree) round trips for what is a single prefix replacement.
    await tx.$executeRaw`
      UPDATE "Folder"
      SET "path" = ${newPrefix} || SUBSTRING("path" FROM ${oldPrefix.length + 1})
      WHERE "path" LIKE ${`${oldPrefix}%`}
    `;
  });
}

/** Folder ids in a subtree, including the folder itself. */
export async function subtreeFolderIds(folderId: string): Promise<string[]> {
  const folder = await prisma.folder.findUnique({ where: { id: folderId } });
  if (!folder) return [];

  const descendants = await prisma.folder.findMany({
    where: { path: { startsWith: `${folder.path}${folder.id}/` } },
    select: { id: true },
  });

  return [folder.id, ...descendants.map((row) => row.id)];
}

/** Names from the root down to this folder, for a breadcrumb. */
export async function breadcrumbFor(folderId: string): Promise<Array<{ id: string; name: string }>> {
  const folder = await prisma.folder.findUnique({ where: { id: folderId } });
  if (!folder) return [];

  const ancestorIds = folder.path.split('/').filter(Boolean);
  if (ancestorIds.length === 0) return [{ id: folder.id, name: folder.name }];

  const ancestors = await prisma.folder.findMany({
    where: { id: { in: ancestorIds } },
    select: { id: true, name: true },
  });

  const byId = new Map(ancestors.map((row) => [row.id, row]));
  const trail = ancestorIds.map((id) => byId.get(id)).filter((row): row is { id: string; name: string } => Boolean(row));

  return [...trail, { id: folder.id, name: folder.name }];
}

async function resolveChildPath(parentId: string | null): Promise<string> {
  if (!parentId) return ROOT_PATH;
  const parent = await prisma.folder.findUniqueOrThrow({ where: { id: parentId } });
  return `${parent.path}${parent.id}/`;
}

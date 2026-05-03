import { readFile, writeFile, mkdir, readdir, unlink } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import type { FlowDefinition } from "../context/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(__dirname, "../../data");

function flowDir(tenantId: string): string {
  return join(DATA_ROOT, tenantId, "flows");
}

function flowPath(tenantId: string, flowId: string): string {
  return join(flowDir(tenantId), `${flowId}.json`);
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export async function saveFlow(
  tenantId: string,
  flow: FlowDefinition
): Promise<FlowDefinition> {
  const dir = flowDir(tenantId);
  await ensureDir(dir);
  await writeFile(flowPath(tenantId, flow.id), JSON.stringify(flow, null, 2), "utf-8");
  return flow;
}

export async function getFlows(tenantId: string): Promise<FlowDefinition[]> {
  const dir = flowDir(tenantId);
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  const flows: FlowDefinition[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await readFile(join(dir, file), "utf-8");
      flows.push(JSON.parse(content) as FlowDefinition);
    } catch {
      // Skip corrupt files
    }
  }

  return flows;
}

export async function getFlow(
  tenantId: string,
  flowId: string
): Promise<FlowDefinition | null> {
  const path = flowPath(tenantId, flowId);
  if (!existsSync(path)) return null;

  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as FlowDefinition;
  } catch {
    return null;
  }
}

export async function deleteFlow(
  tenantId: string,
  flowId: string
): Promise<boolean> {
  const path = flowPath(tenantId, flowId);
  if (!existsSync(path)) return false;

  await unlink(path);
  return true;
}

export async function updateFlow(
  tenantId: string,
  flowId: string,
  updates: Partial<Pick<FlowDefinition, "name" | "description" | "triggerPhrases" | "status">>
): Promise<FlowDefinition | null> {
  const existing = await getFlow(tenantId, flowId);
  if (!existing) return null;

  const updated: FlowDefinition = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await saveFlow(tenantId, updated);
  return updated;
}

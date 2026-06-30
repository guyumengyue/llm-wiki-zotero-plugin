import { invoke } from "@tauri-apps/api/core"

export async function startZotero(executablePath?: string): Promise<string> {
  return invoke<string>("zotero_start", { executablePath })
}

export async function callZoteroBbtRpc(
  method: string,
  params: unknown[] = [],
  rpcUrl?: string,
): Promise<unknown> {
  return invoke<unknown>("zotero_bbt_rpc", {
    method,
    params,
    rpcUrl: rpcUrl ?? null,
  })
}

export async function callZoteroLocalApi(path: string): Promise<unknown> {
  return invoke<unknown>("zotero_local_api_get", { path })
}
